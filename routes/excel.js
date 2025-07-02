const express = require('express');
const multer = require('multer');
const XLSX = require('xlsx');
const path = require('path');
const fs = require('fs');
const Database = require('../models/Database');
const { authenticateToken, requireAccessLevel } = require('../middleware/auth');

const router = express.Router();

// Configure multer for file uploads
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const uploadDir = './uploads';
    if (!fs.existsSync(uploadDir)) {
      fs.mkdirSync(uploadDir, { recursive: true });
    }
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, file.fieldname + '-' + uniqueSuffix + path.extname(file.originalname));
  }
});

const upload = multer({
  storage: storage,
  limits: {
    fileSize: parseInt(process.env.MAX_FILE_SIZE) || 10 * 1024 * 1024 // 10MB default
  },
  fileFilter: (req, file, cb) => {
    const allowedTypes = ['.xlsx', '.xls', '.csv'];
    const fileExt = path.extname(file.originalname).toLowerCase();
    
    if (allowedTypes.includes(fileExt)) {
      cb(null, true);
    } else {
      cb(new Error('Only Excel (.xlsx, .xls) and CSV files are allowed'));
    }
  }
});

// Upload and preview Excel/CSV file
router.post('/upload', authenticateToken, requireAccessLevel(3), upload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }

    const { importType } = req.body; // 'payroll', 'attendance', 'employees'
    
    if (!['payroll', 'attendance', 'employees'].includes(importType)) {
      return res.status(400).json({ error: 'Invalid import type' });
    }

    const filePath = req.file.path;
    const fileExt = path.extname(req.file.originalname).toLowerCase();
    
    let workbook;
    if (fileExt === '.csv') {
      const csvData = fs.readFileSync(filePath, 'utf8');
      workbook = XLSX.read(csvData, { type: 'string' });
    } else {
      workbook = XLSX.readFile(filePath);
    }

    const sheetName = workbook.SheetNames[0];
    const worksheet = workbook.Sheets[sheetName];
    const jsonData = XLSX.utils.sheet_to_json(worksheet, { header: 1 });

    if (jsonData.length === 0) {
      return res.status(400).json({ error: 'File is empty' });
    }

    const headers = jsonData[0];
    const rows = jsonData.slice(1);

    // Validate headers based on import type
    const requiredHeaders = getRequiredHeaders(importType);
    const missingHeaders = requiredHeaders.filter(header => 
      !headers.some(h => h && h.toLowerCase().includes(header.toLowerCase()))
    );

    if (missingHeaders.length > 0) {
      return res.status(400).json({ 
        error: 'Missing required columns', 
        missingHeaders,
        requiredHeaders 
      });
    }

    // Create import log
    const importLogId = await Database.query(
      `INSERT INTO import_logs (file_name, file_type, import_type, total_rows, 
       successful_rows, failed_rows, status, imported_by) 
       VALUES (?, ?, ?, ?, 0, 0, 'processing', ?)`,
      [req.file.originalname, fileExt.substring(1), importType, rows.length, req.user.id]
    );

    // Preview data (first 10 rows)
    const preview = rows.slice(0, 10).map(row => {
      const rowData = {};
      headers.forEach((header, index) => {
        if (header) {
          rowData[header] = row[index] || '';
        }
      });
      return rowData;
    });

    res.json({
      importLogId: importLogId.insertId,
      fileName: req.file.originalname,
      totalRows: rows.length,
      headers,
      preview,
      mappingSuggestions: generateMappingSuggestions(headers, importType)
    });

  } catch (error) {
    console.error('File upload error:', error);
    res.status(500).json({ error: 'Failed to process file' });
  }
});

// Process the imported data
router.post('/process', authenticateToken, requireAccessLevel(3), async (req, res) => {
  try {
    const { importLogId, columnMapping, importType } = req.body;

    if (!importLogId || !columnMapping || !importType) {
      return res.status(400).json({ error: 'Missing required parameters' });
    }

    // Get import log
    const importLog = await Database.query(
      'SELECT * FROM import_logs WHERE id = ? AND imported_by = ?',
      [importLogId, req.user.id]
    );

    if (!importLog.length) {
      return res.status(404).json({ error: 'Import log not found' });
    }

    const log = importLog[0];
    const filePath = `./uploads/${log.file_name}`;

    // Re-read the file
    let workbook;
    if (log.file_type === 'csv') {
      const csvData = fs.readFileSync(filePath, 'utf8');
      workbook = XLSX.read(csvData, { type: 'string' });
    } else {
      workbook = XLSX.readFile(filePath);
    }

    const sheetName = workbook.SheetNames[0];
    const worksheet = workbook.Sheets[sheetName];
    const jsonData = XLSX.utils.sheet_to_json(worksheet, { header: 1 });
    
    const headers = jsonData[0];
    const rows = jsonData.slice(1);

    let successCount = 0;
    let failCount = 0;
    const errors = [];

    // Process each row
    for (let i = 0; i < rows.length; i++) {
      try {
        const rowData = {};
        headers.forEach((header, index) => {
          const mappedField = columnMapping[header];
          if (mappedField) {
            rowData[mappedField] = rows[i][index] || '';
          }
        });

        // Validate and process based on import type
        await processRowData(rowData, importType, req.user.id);
        successCount++;

      } catch (error) {
        failCount++;
        errors.push({
          row: i + 2, // +2 because we start from 1 and skip header
          error: error.message
        });
      }
    }

    // Update import log
    await Database.query(
      `UPDATE import_logs 
       SET successful_rows = ?, failed_rows = ?, status = 'completed', 
           completed_at = NOW(), error_details = ?
       WHERE id = ?`,
      [successCount, failCount, JSON.stringify(errors), importLogId]
    );

    // Log the action
    await Database.logAction(
      req.user.id,
      'IMPORT_DATA',
      'import_logs',
      importLogId,
      null,
      { importType, successCount, failCount },
      req.ip,
      req.get('User-Agent')
    );

    // Clean up uploaded file
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }

    res.json({
      message: 'Import completed',
      successCount,
      failCount,
      errors: errors.slice(0, 50) // Limit errors in response
    });

  } catch (error) {
    console.error('Import processing error:', error);
    res.status(500).json({ error: 'Failed to process import' });
  }
});

// Export data to Excel
router.get('/export/:type', authenticateToken, requireAccessLevel(2), async (req, res) => {
  try {
    const { type } = req.params;
    const { startDate, endDate, department, format = 'xlsx' } = req.query;

    let data = [];
    let filename = '';

    switch (type) {
      case 'payroll':
        data = await exportPayrollData(startDate, endDate, department);
        filename = `payroll-export-${new Date().toISOString().split('T')[0]}`;
        break;
      
      case 'attendance':
        data = await exportAttendanceData(startDate, endDate, department);
        filename = `attendance-export-${new Date().toISOString().split('T')[0]}`;
        break;
      
      case 'employees':
        data = await exportEmployeeData(department);
        filename = `employees-export-${new Date().toISOString().split('T')[0]}`;
        break;
      
      default:
        return res.status(400).json({ error: 'Invalid export type' });
    }

    if (data.length === 0) {
      return res.status(404).json({ error: 'No data found for export' });
    }

    // Create workbook
    const workbook = XLSX.utils.book_new();
    const worksheet = XLSX.utils.json_to_sheet(data);
    XLSX.utils.book_append_sheet(workbook, worksheet, type.charAt(0).toUpperCase() + type.slice(1));

    // Generate buffer
    const buffer = XLSX.write(workbook, { type: 'buffer', bookType: format });

    // Set headers
    res.setHeader('Content-Disposition', `attachment; filename="${filename}.${format}"`);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');

    // Log the action
    await Database.logAction(
      req.user.id,
      'EXPORT_DATA',
      null,
      null,
      null,
      { exportType: type, recordCount: data.length },
      req.ip,
      req.get('User-Agent')
    );

    res.send(buffer);

  } catch (error) {
    console.error('Export error:', error);
    res.status(500).json({ error: 'Failed to export data' });
  }
});

// Get import history
router.get('/imports', authenticateToken, requireAccessLevel(3), async (req, res) => {
  try {
    const imports = await Database.query(
      `SELECT il.*, ua.username as imported_by_username
       FROM import_logs il
       LEFT JOIN user_accounts ua ON il.imported_by = ua.id
       ORDER BY il.created_at DESC
       LIMIT 50`
    );

    res.json(imports);

  } catch (error) {
    console.error('Get imports error:', error);
    res.status(500).json({ error: 'Failed to fetch import history' });
  }
});

// Helper functions
function getRequiredHeaders(importType) {
  switch (importType) {
    case 'payroll':
      return ['employee_number', 'gross_pay', 'net_pay'];
    case 'attendance':
      return ['employee_number', 'date', 'clock_in'];
    case 'employees':
      return ['employee_number', 'first_name', 'last_name', 'department'];
    default:
      return [];
  }
}

function generateMappingSuggestions(headers, importType) {
  const mappings = {};
  const fieldMappings = {
    payroll: {
      'employee_number': ['emp_no', 'employee_id', 'emp_id', 'employee_number'],
      'gross_pay': ['gross', 'gross_pay', 'gross_amount'],
      'net_pay': ['net', 'net_pay', 'net_amount', 'take_home'],
      'basic_pay': ['basic', 'basic_pay', 'basic_salary'],
      'overtime_pay': ['overtime', 'ot_pay', 'overtime_amount']
    },
    attendance: {
      'employee_number': ['emp_no', 'employee_id', 'emp_id', 'employee_number'],
      'date': ['date', 'work_date', 'attendance_date'],
      'clock_in': ['time_in', 'clock_in', 'start_time'],
      'clock_out': ['time_out', 'clock_out', 'end_time']
    },
    employees: {
      'employee_number': ['emp_no', 'employee_id', 'emp_id', 'employee_number'],
      'first_name': ['first_name', 'fname', 'given_name'],
      'last_name': ['last_name', 'lname', 'surname', 'family_name'],
      'department': ['department', 'dept', 'division'],
      'position': ['position', 'job_title', 'title', 'role']
    }
  };

  const typeMapping = fieldMappings[importType] || {};

  headers.forEach(header => {
    const lowerHeader = header.toLowerCase();
    for (const [field, variations] of Object.entries(typeMapping)) {
      if (variations.some(variation => lowerHeader.includes(variation))) {
        mappings[header] = field;
        break;
      }
    }
  });

  return mappings;
}

async function processRowData(rowData, importType, userId) {
  switch (importType) {
    case 'employees':
      await processEmployeeRow(rowData, userId);
      break;
    case 'attendance':
      await processAttendanceRow(rowData, userId);
      break;
    case 'payroll':
      await processPayrollRow(rowData, userId);
      break;
    default:
      throw new Error('Invalid import type');
  }
}

async function processEmployeeRow(rowData, userId) {
  const requiredFields = ['employee_number', 'first_name', 'last_name', 'department'];
  
  for (const field of requiredFields) {
    if (!rowData[field]) {
      throw new Error(`Missing required field: ${field}`);
    }
  }

  // Check if employee already exists
  const existing = await Database.query(
    'SELECT id FROM employees WHERE employee_number = ?',
    [rowData.employee_number]
  );

  if (existing.length > 0) {
    throw new Error(`Employee ${rowData.employee_number} already exists`);
  }

  await Database.createEmployee({
    employee_number: rowData.employee_number,
    first_name: rowData.first_name,
    last_name: rowData.last_name,
    email: rowData.email || null,
    phone: rowData.phone || null,
    department: rowData.department,
    position: rowData.position || 'Employee',
    hire_date: rowData.hire_date || new Date().toISOString().split('T')[0],
    birth_date: rowData.birth_date || null,
    address: rowData.address || null,
    emergency_contact_name: rowData.emergency_contact_name || null,
    emergency_contact_phone: rowData.emergency_contact_phone || null,
    hourly_rate: rowData.hourly_rate || null,
    salary: rowData.salary || null,
    pay_type: rowData.pay_type || 'hourly',
    is_active: true,
    sss_number: rowData.sss_number || null,
    philhealth_number: rowData.philhealth_number || null,
    pagibig_number: rowData.pagibig_number || null,
    tin_number: rowData.tin_number || null,
    bank_account: rowData.bank_account || null
  });
}

async function processAttendanceRow(rowData, userId) {
  // Implementation for attendance import
  const requiredFields = ['employee_number', 'date', 'clock_in'];
  
  for (const field of requiredFields) {
    if (!rowData[field]) {
      throw new Error(`Missing required field: ${field}`);
    }
  }

  // Get employee ID
  const employee = await Database.query(
    'SELECT id FROM employees WHERE employee_number = ?',
    [rowData.employee_number]
  );

  if (!employee.length) {
    throw new Error(`Employee ${rowData.employee_number} not found`);
  }

  // Insert time entry
  await Database.query(
    `INSERT INTO time_entries (employee_id, clock_in, clock_out, date, total_hours, regular_hours, overtime_hours, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'completed')`,
    [
      employee[0].id,
      `${rowData.date} ${rowData.clock_in}`,
      rowData.clock_out ? `${rowData.date} ${rowData.clock_out}` : null,
      rowData.date,
      rowData.total_hours || null,
      rowData.regular_hours || null,
      rowData.overtime_hours || null
    ]
  );
}

async function processPayrollRow(rowData, userId) {
  // Implementation for payroll import
  const requiredFields = ['employee_number', 'gross_pay', 'net_pay'];
  
  for (const field of requiredFields) {
    if (!rowData[field]) {
      throw new Error(`Missing required field: ${field}`);
    }
  }

  // Get employee ID
  const employee = await Database.query(
    'SELECT id FROM employees WHERE employee_number = ?',
    [rowData.employee_number]
  );

  if (!employee.length) {
    throw new Error(`Employee ${rowData.employee_number} not found`);
  }

  // Get current payroll period
  const period = await Database.query(
    'SELECT id FROM payroll_periods WHERE status = "open" ORDER BY start_date DESC LIMIT 1'
  );

  if (!period.length) {
    throw new Error('No open payroll period found');
  }

  // Insert payroll entry
  await Database.query(
    `INSERT INTO payroll_entries (
      employee_id, payroll_period_id, gross_pay, basic_pay, overtime_pay,
      sss_deduction, philhealth_deduction, pagibig_deduction, withholding_tax,
      other_deductions, total_deductions, net_pay, status
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'calculated')`,
    [
      employee[0].id,
      period[0].id,
      rowData.gross_pay,
      rowData.basic_pay || rowData.gross_pay,
      rowData.overtime_pay || 0,
      rowData.sss_deduction || 0,
      rowData.philhealth_deduction || 0,
      rowData.pagibig_deduction || 0,
      rowData.withholding_tax || 0,
      rowData.other_deductions || 0,
      (rowData.sss_deduction || 0) + (rowData.philhealth_deduction || 0) + 
      (rowData.pagibig_deduction || 0) + (rowData.withholding_tax || 0) + 
      (rowData.other_deductions || 0),
      rowData.net_pay
    ]
  );
}

async function exportPayrollData(startDate, endDate, department) {
  let sql = `
    SELECT 
      e.employee_number,
      e.first_name,
      e.last_name,
      e.department,
      e.position,
      pp.period_name,
      pp.start_date,
      pp.end_date,
      pe.gross_pay,
      pe.basic_pay,
      pe.overtime_pay,
      pe.allowances,
      pe.bonuses,
      pe.sss_deduction,
      pe.philhealth_deduction,
      pe.pagibig_deduction,
      pe.withholding_tax,
      pe.other_deductions,
      pe.total_deductions,
      pe.net_pay,
      pe.status
    FROM payroll_entries pe
    JOIN employees e ON pe.employee_id = e.id
    JOIN payroll_periods pp ON pe.payroll_period_id = pp.id
    WHERE 1=1
  `;
  
  const params = [];
  
  if (startDate) {
    sql += ' AND pp.start_date >= ?';
    params.push(startDate);
  }
  
  if (endDate) {
    sql += ' AND pp.end_date <= ?';
    params.push(endDate);
  }
  
  if (department) {
    sql += ' AND e.department = ?';
    params.push(department);
  }
  
  sql += ' ORDER BY pp.start_date DESC, e.last_name, e.first_name';
  
  return await Database.query(sql, params);
}

async function exportAttendanceData(startDate, endDate, department) {
  let sql = `
    SELECT 
      e.employee_number,
      e.first_name,
      e.last_name,
      e.department,
      te.date,
      te.clock_in,
      te.clock_out,
      te.break_start,
      te.break_end,
      te.total_hours,
      te.regular_hours,
      te.overtime_hours,
      te.status,
      te.location
    FROM time_entries te
    JOIN employees e ON te.employee_id = e.id
    WHERE 1=1
  `;
  
  const params = [];
  
  if (startDate) {
    sql += ' AND te.date >= ?';
    params.push(startDate);
  }
  
  if (endDate) {
    sql += ' AND te.date <= ?';
    params.push(endDate);
  }
  
  if (department) {
    sql += ' AND e.department = ?';
    params.push(department);
  }
  
  sql += ' ORDER BY te.date DESC, e.last_name, e.first_name';
  
  return await Database.query(sql, params);
}

async function exportEmployeeData(department) {
  let sql = `
    SELECT 
      employee_number,
      first_name,
      last_name,
      email,
      phone,
      department,
      position,
      hire_date,
      birth_date,
      address,
      emergency_contact_name,
      emergency_contact_phone,
      hourly_rate,
      salary,
      pay_type,
      is_active,
      sss_number,
      philhealth_number,
      pagibig_number,
      tin_number,
      bank_account
    FROM employees
    WHERE 1=1
  `;
  
  const params = [];
  
  if (department) {
    sql += ' AND department = ?';
    params.push(department);
  }
  
  sql += ' ORDER BY last_name, first_name';
  
  return await Database.query(sql, params);
}

module.exports = router;