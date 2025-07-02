const jwt = require('jsonwebtoken');
const Database = require('../models/Database');

const authenticateToken = async (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) {
    return res.status(401).json({ error: 'Access token required' });
  }

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const user = await Database.getUserByUsername(decoded.username);
    
    if (!user || !user.is_active) {
      return res.status(403).json({ error: 'User not found or inactive' });
    }

    req.user = user;
    next();
  } catch (error) {
    return res.status(403).json({ error: 'Invalid or expired token' });
  }
};

const requireAccessLevel = (minLevel) => {
  return (req, res, next) => {
    if (!req.user || req.user.access_level < minLevel) {
      return res.status(403).json({ error: 'Insufficient access level' });
    }
    next();
  };
};

const requirePermission = (permission) => {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    const permissions = req.user.permissions ? JSON.parse(req.user.permissions) : {};
    
    if (!permissions[permission] && !permissions.full_access) {
      return res.status(403).json({ error: `Permission '${permission}' required` });
    }
    
    next();
  };
};

module.exports = {
  authenticateToken,
  requireAccessLevel,
  requirePermission
};