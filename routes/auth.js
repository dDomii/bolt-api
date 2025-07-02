const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const Database = require('../models/Database');
const { authenticateToken } = require('../middleware/auth');

const router = express.Router();

// Login
router.post('/login', async (req, res) => {
  try {
    const { username, password } = req.body;

    if (!username || !password) {
      return res.status(400).json({ error: 'Username and password required' });
    }

    const user = await Database.getUserByUsername(username);
    
    if (!user) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    // Check if account is locked
    if (user.locked_until && new Date() < new Date(user.locked_until)) {
      return res.status(423).json({ error: 'Account temporarily locked' });
    }

    const isValidPassword = await bcrypt.compare(password, user.password_hash);
    
    if (!isValidPassword) {
      // Increment failed login attempts
      await Database.query(
        'UPDATE user_accounts SET failed_login_attempts = failed_login_attempts + 1 WHERE id = ?',
        [user.id]
      );
      
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    // Reset failed login attempts and update last login
    await Database.query(
      'UPDATE user_accounts SET failed_login_attempts = 0, locked_until = NULL, last_login = NOW() WHERE id = ?',
      [user.id]
    );

    // Generate JWT token
    const token = jwt.sign(
      { 
        id: user.id, 
        username: user.username, 
        access_level: user.access_level 
      },
      process.env.JWT_SECRET,
      { expiresIn: process.env.JWT_EXPIRES_IN || '24h' }
    );

    // Log the login
    await Database.logAction(
      user.id,
      'LOGIN',
      'user_accounts',
      user.id,
      null,
      { login_time: new Date() },
      req.ip,
      req.get('User-Agent')
    );

    res.json({
      token,
      user: {
        id: user.id,
        username: user.username,
        email: user.email,
        access_level: user.access_level,
        level_name: user.level_name,
        employee_id: user.employee_id,
        first_name: user.first_name,
        last_name: user.last_name,
        employee_number: user.employee_number,
        department: user.department,
        permissions: user.permissions ? JSON.parse(user.permissions) : {}
      }
    });

  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Register (Admin only)
router.post('/register', authenticateToken, async (req, res) => {
  try {
    if (req.user.access_level < 3) {
      return res.status(403).json({ error: 'Insufficient permissions' });
    }

    const {
      employee_id,
      username,
      email,
      password,
      access_level,
      department_id,
      approver_id
    } = req.body;

    if (!username || !password || !employee_id) {
      return res.status(400).json({ error: 'Username, password, and employee_id required' });
    }

    // Check if username already exists
    const existingUser = await Database.getUserByUsername(username);
    if (existingUser) {
      return res.status(409).json({ error: 'Username already exists' });
    }

    // Hash password
    const password_hash = await bcrypt.hash(password, 10);

    // Create user
    const userId = await Database.createUser({
      employee_id,
      username,
      email,
      password_hash,
      access_level: access_level || 1,
      department_id,
      approver_id,
      is_active: true
    });

    // Log the action
    await Database.logAction(
      req.user.id,
      'CREATE_USER',
      'user_accounts',
      userId,
      null,
      { username, access_level },
      req.ip,
      req.get('User-Agent')
    );

    res.status(201).json({ message: 'User created successfully', userId });

  } catch (error) {
    console.error('Registration error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get current user profile
router.get('/profile', authenticateToken, (req, res) => {
  res.json({
    user: {
      id: req.user.id,
      username: req.user.username,
      email: req.user.email,
      access_level: req.user.access_level,
      level_name: req.user.level_name,
      employee_id: req.user.employee_id,
      first_name: req.user.first_name,
      last_name: req.user.last_name,
      employee_number: req.user.employee_number,
      department: req.user.department,
      permissions: req.user.permissions ? JSON.parse(req.user.permissions) : {}
    }
  });
});

// Change password
router.post('/change-password', authenticateToken, async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;

    if (!currentPassword || !newPassword) {
      return res.status(400).json({ error: 'Current and new password required' });
    }

    const user = await Database.getUserByUsername(req.user.username);
    const isValidPassword = await bcrypt.compare(currentPassword, user.password_hash);
    
    if (!isValidPassword) {
      return res.status(401).json({ error: 'Current password is incorrect' });
    }

    const newPasswordHash = await bcrypt.hash(newPassword, 10);
    
    await Database.query(
      'UPDATE user_accounts SET password_hash = ?, password_changed_at = NOW() WHERE id = ?',
      [newPasswordHash, req.user.id]
    );

    // Log the action
    await Database.logAction(
      req.user.id,
      'CHANGE_PASSWORD',
      'user_accounts',
      req.user.id,
      null,
      { password_changed: true },
      req.ip,
      req.get('User-Agent')
    );

    res.json({ message: 'Password changed successfully' });

  } catch (error) {
    console.error('Change password error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;