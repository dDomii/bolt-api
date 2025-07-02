const express = require('express');
const Database = require('../models/Database');
const { authenticateToken, requireAccessLevel } = require('../middleware/auth');

const router = express.Router();

// Run reconciliation for a payroll period
router.post('/run/:periodId', authenticateToken, requireAccessLevel(3), async (req, res) => {
  try {
    const { periodId } = req.params;
    const { reconciliationType = 'all' } = req.body;

    // Get payroll period
    const period = await Database.query(
      'SELECT * FROM payroll_periods WHERE id = ?',
      [periodId]
    );

    if (!period.length) {
      return res.status(404).json({ error: 'Payroll period not found' });
    }

    const reconciliationResults = [];

    if (reconciliationType === 'all' || reconciliationType === 'payroll') {
      const payrollDiscrepancies = await runPayrollReconciliation(periodId);
      reconciliationResults.push(...payrollDiscrepancies);
    }

    if (reconciliationType === 'all' || reconciliationType === 'attendance') {
      const attendanceDiscrepancies = await runAttendanceReconciliation(periodId);
      reconciliationResults.push(...attendanceDiscrepancies);
    }

    if (reconciliationType === 'all' || reconciliationType === 'deductions') {
      const deductionDiscrepancies = await runDeductionReconciliation(periodId);
      reconciliationResults.push(...deductionDiscrepancies);
    }

    // Save reconciliation results
    for (const discrepancy of reconciliationResults) {
      await Database.createReconciliationLog({
        payroll_period_id: periodId,
        reconciliation_type: discrepancy.type,
        employee_id: discrepancy.employee_id,
        discrepancy_type: discrepancy.discrepancy_type,
        expected_value: discrepancy.expected_value,
        actual_value: discrepancy.actual_value,
        variance: discrepancy.variance,
        description: discrepancy.description
      });
    }

    // Log the action
    await Database.logAction(
      req.user.id,
      'RUN_RECONCILIATION',
      'reconciliation_logs',
      periodId,
      null,
      { reconciliationType, discrepanciesFound: reconciliationResults.length },
      req.ip,
      req.get('User-Agent')
    );

    res.json({
      message: 'Reconciliation completed',
      discrepanciesFound: reconciliationResults.length,
      results: reconciliationResults
    });

  } catch (error) {
    console.error('Reconciliation error:', error);
    res.status(500).json({ error: 'Failed to run reconciliation' });
  }
});

// Get reconciliation results
router.get('/results/:periodId', authenticateToken, requireAccessLevel(2), async (req, res) => {
  try {
    const { periodId } = req.params;
    const { status, type } = req.query;

    const results = await Database.getReconciliationLogs(periodId, status);

    let filteredResults = results;
    if (type) {
      filteredResults = results.filter(r => r.reconciliation_type === type);
    }

    // Group by reconciliation type
    const groupedResults = filteredResults.reduce((acc, result) => {
      const type = result.reconciliation_type;
      if (!acc[type]) {
        acc[type] = [];
      }
      acc[type].push(result);
      return acc;
    }, {});

    // Calculate summary statistics
    const summary = {
      total: filteredResults.length,
      pending: filteredResults.filter(r => r.status === 'pending').length,
      resolved: filteredResults.filter(r => r.status === 'resolved').length,
      ignored: filteredResults.filter(r => r.status === 'ignored').length,
      totalVariance: filteredResults.reduce((sum, r) => sum + Math.abs(r.variance || 0), 0)
    };

    res.json({
      summary,
      results: groupedResults,
      period: await Database.query('SELECT * FROM payroll_periods WHERE id = ?', [periodId])
    });

  } catch (error) {
    console.error('Get reconciliation results error:', error);
    res.status(500).json({ error: 'Failed to fetch reconciliation results' });
  }
});

// Resolve a reconciliation discrepancy
router.patch('/resolve/:logId', authenticateToken, requireAccessLevel(3), async (req, res) => {
  try {
    const { logId } = req.params;
    const { status, resolutionNotes } = req.body;

    if (!['resolved', 'ignored'].includes(status)) {
      return res.status(400).json({ error: 'Invalid status. Must be "resolved" or "ignored"' });
    }

    await Database.query(
      `UPDATE reconciliation_logs 
       SET status = ?, resolved_by = ?, resolved_at = NOW(), resolution_notes = ?
       WHERE id = ?`,
      [status, req.user.id, resolutionNotes, logId]
    );

    // Log the action
    await Database.logAction(
      req.user.id,
      'RESOLVE_RECONCILIATION',
      'reconciliation_logs',
      logId,
      null,
      { status, resolutionNotes },
      req.ip,
      req.get('User-Agent')
    );

    res.json({ message: 'Reconciliation discrepancy resolved' });

  } catch (error) {
    console.error('Resolve reconciliation error:', error);
    res.status(500).json({ error: 'Failed to resolve reconciliation discrepancy' });
  }
});

// Get reconciliation dashboard data
router.get('/dashboard', authenticateToken, requireAccessLevel(2), async (req, res) => {
  try {
    const { department, dateRange = '30' } = req.query;

    // Get recent reconciliation summary
    let sql = `
      SELECT 
        pp.period_name,
        pp.start_date,
        pp.end_date,
        COUNT(rl.id) as total_discrepancies,
        COUNT(CASE WHEN rl.status = 'pending' THEN 1 END) as pending_discrepancies,
        COUNT(CASE WHEN rl.status = 'resolved' THEN 1 END) as resolved_discrepancies,
        SUM(ABS(rl.variance)) as total_variance
      FROM payroll_periods pp
      LEFT JOIN reconciliation_logs rl ON pp.id = rl.payroll_period_id
      WHERE pp.start_date >= DATE_SUB(NOW(), INTERVAL ? DAY)
    `;
    
    const params = [parseInt(dateRange)];

    if (department) {
      sql += ` AND EXISTS (
        SELECT 1 FROM employees e 
        WHERE e.id = rl.employee_id AND e.department = ?
      )`;
      params.push(department);
    }

    sql += ' GROUP BY pp.id ORDER BY pp.start_date DESC';

    const periodSummary = await Database.query(sql, params);

    // Get discrepancy types breakdown
    const discrepancyTypes = await Database.query(`
      SELECT 
        reconciliation_type,
        discrepancy_type,
        COUNT(*) as count,
        AVG(ABS(variance)) as avg_variance
      FROM reconciliation_logs rl
      JOIN payroll_periods pp ON rl.payroll_period_id = pp.id
      WHERE pp.start_date >= DATE_SUB(NOW(), INTERVAL ? DAY)
      GROUP BY reconciliation_type, discrepancy_type
      ORDER BY count DESC
    `, [parseInt(dateRange)]);

    // Get top employees with discrepancies
    const topEmployees = await Database.query(`
      SELECT 
        e.employee_number,
        e.first_name,
        e.last_name,
        e.department,
        COUNT(rl.id) as discrepancy_count,
        SUM(ABS(rl.variance)) as total_variance
      FROM reconciliation_logs rl
      JOIN employees e ON rl.employee_id = e.id
      JOIN payroll_periods pp ON rl.payroll_period_id = pp.id
      WHERE pp.start_date >= DATE_SUB(NOW(), INTERVAL ? DAY)
        AND rl.status = 'pending'
      GROUP BY e.id
      ORDER BY discrepancy_count DESC, total_variance DESC
      LIMIT 10
    `, [parseInt(dateRange)]);

    res.json({
      periodSummary,
      discrepancyTypes,
      topEmployees,
      dateRange: parseInt(dateRange)
    });

  } catch (error) {
    console.error('Reconciliation dashboard error:', error);
    res.status(500).json({ error: 'Failed to fetch reconciliation dashboard data' });
  }
});

// Helper functions for different reconciliation types
async function runPayrollReconciliation(periodId) {
  const discrepancies = [];

  // Get payroll entries for the period
  const payrollEntries = await Database.query(`
    SELECT pe.*, e.employee_number, e.first_name, e.last_name, e.hourly_rate, e.salary, e.pay_type
    FROM payroll_entries pe
    JOIN employees e ON pe.employee_id = e.id
    WHERE pe.payroll_period_id = ?
  `, [periodId]);

  for (const entry of payrollEntries) {
    // Check gross pay calculation
    const expectedGrossPay = calculateExpectedGrossPay(entry);
    const grossPayVariance = Math.abs(entry.gross_pay - expectedGrossPay);
    
    if (grossPayVariance > 0.01) { // Allow for rounding differences
      discrepancies.push({
        type: 'payroll',
        employee_id: entry.employee_id,
        discrepancy_type: 'gross_pay_mismatch',
        expected_value: expectedGrossPay,
        actual_value: entry.gross_pay,
        variance: entry.gross_pay - expectedGrossPay,
        description: `Gross pay mismatch for ${entry.first_name} ${entry.last_name} (${entry.employee_number})`
      });
    }

    // Check net pay calculation
    const expectedNetPay = entry.gross_pay - entry.total_deductions;
    const netPayVariance = Math.abs(entry.net_pay - expectedNetPay);
    
    if (netPayVariance > 0.01) {
      discrepancies.push({
        type: 'payroll',
        employee_id: entry.employee_id,
        discrepancy_type: 'net_pay_mismatch',
        expected_value: expectedNetPay,
        actual_value: entry.net_pay,
        variance: entry.net_pay - expectedNetPay,
        description: `Net pay calculation error for ${entry.first_name} ${entry.last_name} (${entry.employee_number})`
      });
    }
  }

  return discrepancies;
}

async function runAttendanceReconciliation(periodId) {
  const discrepancies = [];

  // Get period dates
  const period = await Database.query(
    'SELECT start_date, end_date FROM payroll_periods WHERE id = ?',
    [periodId]
  );

  if (!period.length) return discrepancies;

  const { start_date, end_date } = period[0];

  // Get time entries and payroll entries for comparison
  const attendanceData = await Database.query(`
    SELECT 
      e.id as employee_id,
      e.employee_number,
      e.first_name,
      e.last_name,
      SUM(te.regular_hours) as total_regular_hours,
      SUM(te.overtime_hours) as total_overtime_hours,
      pe.hours_worked as payroll_hours,
      pe.overtime_hours as payroll_overtime
    FROM employees e
    LEFT JOIN time_entries te ON e.id = te.employee_id 
      AND te.date BETWEEN ? AND ? 
      AND te.status = 'completed'
    LEFT JOIN payroll_entries pe ON e.id = pe.employee_id 
      AND pe.payroll_period_id = ?
    WHERE e.is_active = true
    GROUP BY e.id
  `, [start_date, end_date, periodId]);

  for (const data of attendanceData) {
    // Check regular hours
    const regularHoursVariance = Math.abs((data.total_regular_hours || 0) - (data.payroll_hours || 0));
    
    if (regularHoursVariance > 0.25) { // Allow for 15-minute differences
      discrepancies.push({
        type: 'attendance',
        employee_id: data.employee_id,
        discrepancy_type: 'regular_hours_mismatch',
        expected_value: data.total_regular_hours || 0,
        actual_value: data.payroll_hours || 0,
        variance: (data.payroll_hours || 0) - (data.total_regular_hours || 0),
        description: `Regular hours mismatch for ${data.first_name} ${data.last_name} (${data.employee_number})`
      });
    }

    // Check overtime hours
    const overtimeVariance = Math.abs((data.total_overtime_hours || 0) - (data.payroll_overtime || 0));
    
    if (overtimeVariance > 0.25) {
      discrepancies.push({
        type: 'attendance',
        employee_id: data.employee_id,
        discrepancy_type: 'overtime_hours_mismatch',
        expected_value: data.total_overtime_hours || 0,
        actual_value: data.payroll_overtime || 0,
        variance: (data.payroll_overtime || 0) - (data.total_overtime_hours || 0),
        description: `Overtime hours mismatch for ${data.first_name} ${data.last_name} (${data.employee_number})`
      });
    }
  }

  return discrepancies;
}

async function runDeductionReconciliation(periodId) {
  const discrepancies = [];

  // Get system settings for deduction rates
  const settings = await Database.getSystemSettings();
  const settingsMap = settings.reduce((acc, setting) => {
    acc[setting.setting_key] = parseFloat(setting.setting_value);
    return acc;
  }, {});

  // Get payroll entries with employee data
  const payrollEntries = await Database.query(`
    SELECT pe.*, e.employee_number, e.first_name, e.last_name, e.salary, e.hourly_rate
    FROM payroll_entries pe
    JOIN employees e ON pe.employee_id = e.id
    WHERE pe.payroll_period_id = ?
  `, [periodId]);

  for (const entry of payrollEntries) {
    // Check SSS deduction
    const expectedSSS = entry.basic_pay * (settingsMap.sss_rate || 0.045);
    const sssVariance = Math.abs(entry.sss_deduction - expectedSSS);
    
    if (sssVariance > 0.01) {
      discrepancies.push({
        type: 'deductions',
        employee_id: entry.employee_id,
        discrepancy_type: 'sss_deduction_mismatch',
        expected_value: expectedSSS,
        actual_value: entry.sss_deduction,
        variance: entry.sss_deduction - expectedSSS,
        description: `SSS deduction mismatch for ${entry.first_name} ${entry.last_name} (${entry.employee_number})`
      });
    }

    // Check PhilHealth deduction
    const expectedPhilHealth = entry.basic_pay * (settingsMap.philhealth_rate || 0.0275);
    const philHealthVariance = Math.abs(entry.philhealth_deduction - expectedPhilHealth);
    
    if (philHealthVariance > 0.01) {
      discrepancies.push({
        type: 'deductions',
        employee_id: entry.employee_id,
        discrepancy_type: 'philhealth_deduction_mismatch',
        expected_value: expectedPhilHealth,
        actual_value: entry.philhealth_deduction,
        variance: entry.philhealth_deduction - expectedPhilHealth,
        description: `PhilHealth deduction mismatch for ${entry.first_name} ${entry.last_name} (${entry.employee_number})`
      });
    }

    // Check Pag-IBIG deduction
    const expectedPagIbig = entry.basic_pay * (settingsMap.pagibig_rate || 0.02);
    const pagIbigVariance = Math.abs(entry.pagibig_deduction - expectedPagIbig);
    
    if (pagIbigVariance > 0.01) {
      discrepancies.push({
        type: 'deductions',
        employee_id: entry.employee_id,
        discrepancy_type: 'pagibig_deduction_mismatch',
        expected_value: expectedPagIbig,
        actual_value: entry.pagibig_deduction,
        variance: entry.pagibig_deduction - expectedPagIbig,
        description: `Pag-IBIG deduction mismatch for ${entry.first_name} ${entry.last_name} (${entry.employee_number})`
      });
    }
  }

  return discrepancies;
}

function calculateExpectedGrossPay(entry) {
  if (entry.pay_type === 'salary') {
    return entry.salary / 26; // Bi-weekly
  } else {
    const regularPay = (entry.hours_worked || 0) * (entry.hourly_rate || 0);
    const overtimePay = (entry.overtime_hours || 0) * (entry.hourly_rate || 0) * 1.5;
    return regularPay + overtimePay;
  }
}

module.exports = router;