const { getConnection } = require('../config/database');

class Database {
  constructor() {
    this.pool = null;
  }

  async init() {
    this.pool = getConnection();
  }

  async query(sql, params = []) {
    try {
      const [rows] = await this.pool.execute(sql, params);
      return rows;
    } catch (error) {
      console.error('Database query error:', error);
      throw error;
    }
  }

  async transaction(callback) {
    const connection = await this.pool.getConnection();
    try {
      await connection.beginTransaction();
      const result = await callback(connection);
      await connection.commit();
      return result;
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  }

  // User Management
  async createUser(userData) {
    const sql = `
      INSERT INTO user_accounts (
        employee_id, username, email, password_hash, access_level, 
        department_id, approver_id, is_active
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `;
    const params = [
      userData.employee_id,
      userData.username,
      userData.email,
      userData.password_hash,
      userData.access_level,
      userData.department_id,
      userData.approver_id,
      userData.is_active
    ];
    
    const result = await this.query(sql, params);
    return result.insertId;
  }

  async getUserByUsername(username) {
    const sql = `
      SELECT ua.*, e.first_name, e.last_name, e.employee_number, e.department,
             d.name as department_name, al.level_name, al.permissions
      FROM user_accounts ua
      LEFT JOIN employees e ON ua.employee_id = e.id
      LEFT JOIN departments d ON ua.department_id = d.id
      LEFT JOIN access_levels al ON ua.access_level = al.level_number
      WHERE ua.username = ? AND ua.is_active = true
    `;
    const result = await this.query(sql, [username]);
    return result[0];
  }

  async updateUserLastLogin(userId) {
    const sql = 'UPDATE user_accounts SET last_login = NOW() WHERE id = ?';
    await this.query(sql, [userId]);
  }

  // Employee Management
  async createEmployee(employeeData) {
    const sql = `
      INSERT INTO employees (
        employee_number, first_name, last_name, email, phone, department,
        position, hire_date, birth_date, address, emergency_contact_name,
        emergency_contact_phone, hourly_rate, salary, pay_type, is_active,
        sss_number, philhealth_number, pagibig_number, tin_number, bank_account
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `;
    const params = [
      employeeData.employee_number,
      employeeData.first_name,
      employeeData.last_name,
      employeeData.email,
      employeeData.phone,
      employeeData.department,
      employeeData.position,
      employeeData.hire_date,
      employeeData.birth_date,
      employeeData.address,
      employeeData.emergency_contact_name,
      employeeData.emergency_contact_phone,
      employeeData.hourly_rate,
      employeeData.salary,
      employeeData.pay_type,
      employeeData.is_active,
      employeeData.sss_number,
      employeeData.philhealth_number,
      employeeData.pagibig_number,
      employeeData.tin_number,
      employeeData.bank_account
    ];
    
    const result = await this.query(sql, params);
    return result.insertId;
  }

  async getEmployees(filters = {}) {
    let sql = 'SELECT * FROM employees WHERE 1=1';
    const params = [];

    if (filters.is_active !== undefined) {
      sql += ' AND is_active = ?';
      params.push(filters.is_active);
    }

    if (filters.department) {
      sql += ' AND department = ?';
      params.push(filters.department);
    }

    sql += ' ORDER BY first_name, last_name';
    return await this.query(sql, params);
  }

  // Time Tracking
  async clockIn(employeeId, location, ipAddress) {
    const sql = `
      INSERT INTO time_entries (employee_id, clock_in, date, location, ip_address, status)
      VALUES (?, NOW(), CURDATE(), ?, ?, 'active')
    `;
    const result = await this.query(sql, [employeeId, location, ipAddress]);
    return result.insertId;
  }

  async clockOut(employeeId) {
    const sql = `
      UPDATE time_entries 
      SET clock_out = NOW(), 
          total_hours = TIMESTAMPDIFF(MINUTE, clock_in, NOW()) / 60,
          regular_hours = LEAST(TIMESTAMPDIFF(MINUTE, clock_in, NOW()) / 60, 8),
          overtime_hours = GREATEST(TIMESTAMPDIFF(MINUTE, clock_in, NOW()) / 60 - 8, 0),
          status = 'completed'
      WHERE employee_id = ? AND date = CURDATE() AND status = 'active'
    `;
    await this.query(sql, [employeeId]);
  }

  async getTodayTimeEntry(employeeId) {
    const sql = `
      SELECT * FROM time_entries 
      WHERE employee_id = ? AND date = CURDATE()
      ORDER BY created_at DESC LIMIT 1
    `;
    const result = await this.query(sql, [employeeId]);
    return result[0];
  }

  // Payroll Management
  async createPayrollPeriod(periodData) {
    const sql = `
      INSERT INTO payroll_periods (period_name, start_date, end_date, pay_date, status)
      VALUES (?, ?, ?, ?, ?)
    `;
    const params = [
      periodData.period_name,
      periodData.start_date,
      periodData.end_date,
      periodData.pay_date,
      periodData.status || 'open'
    ];
    
    const result = await this.query(sql, params);
    return result.insertId;
  }

  async getPayrollPeriods(status = null) {
    let sql = 'SELECT * FROM payroll_periods';
    const params = [];

    if (status) {
      sql += ' WHERE status = ?';
      params.push(status);
    }

    sql += ' ORDER BY start_date DESC';
    return await this.query(sql, params);
  }

  // Reconciliation
  async createReconciliationLog(logData) {
    const sql = `
      INSERT INTO reconciliation_logs (
        payroll_period_id, reconciliation_type, employee_id, discrepancy_type,
        expected_value, actual_value, variance, description
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `;
    const params = [
      logData.payroll_period_id,
      logData.reconciliation_type,
      logData.employee_id,
      logData.discrepancy_type,
      logData.expected_value,
      logData.actual_value,
      logData.variance,
      logData.description
    ];
    
    const result = await this.query(sql, params);
    return result.insertId;
  }

  async getReconciliationLogs(periodId, status = null) {
    let sql = `
      SELECT rl.*, e.first_name, e.last_name, e.employee_number
      FROM reconciliation_logs rl
      LEFT JOIN employees e ON rl.employee_id = e.id
      WHERE rl.payroll_period_id = ?
    `;
    const params = [periodId];

    if (status) {
      sql += ' AND rl.status = ?';
      params.push(status);
    }

    sql += ' ORDER BY rl.created_at DESC';
    return await this.query(sql, params);
  }

  // System Settings
  async getSystemSettings() {
    const sql = 'SELECT * FROM system_settings ORDER BY setting_key';
    return await this.query(sql);
  }

  async updateSystemSetting(key, value, userId) {
    const sql = `
      UPDATE system_settings 
      SET setting_value = ?, updated_by = ?, updated_at = NOW()
      WHERE setting_key = ?
    `;
    await this.query(sql, [value, userId, key]);
  }

  // Audit Logging
  async logAction(userId, action, tableName, recordId, oldValues, newValues, ipAddress, userAgent) {
    const sql = `
      INSERT INTO audit_logs (
        user_id, action, table_name, record_id, old_values, new_values, ip_address, user_agent
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `;
    const params = [
      userId,
      action,
      tableName,
      recordId,
      oldValues ? JSON.stringify(oldValues) : null,
      newValues ? JSON.stringify(newValues) : null,
      ipAddress,
      userAgent
    ];
    
    await this.query(sql, params);
  }
}

module.exports = new Database();