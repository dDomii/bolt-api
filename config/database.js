const mysql = require('mysql2/promise');
require('dotenv').config();

const dbConfig = {
  host: process.env.DB_HOST || '116.50.227.178',
  port: process.env.DB_PORT || 80,
  user: process.env.DB_USER || 'domuser',
  password: process.env.DB_PASSWORD || 'dompass',
  database: process.env.DB_NAME || 'domsbolt',
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
  acquireTimeout: 60000,
  timeout: 60000,
  reconnect: true
};

let pool;

const createConnection = async () => {
  try {
    pool = mysql.createPool(dbConfig);
    console.log('✅ MySQL connection pool created successfully');
    console.log(`📍 Connected to: ${dbConfig.host}:${dbConfig.port}/${dbConfig.database}`);
    
    // Test the connection
    const connection = await pool.getConnection();
    await connection.ping();
    connection.release();
    console.log('✅ Database connection tested successfully');
    
    return pool;
  } catch (error) {
    console.error('❌ Error creating MySQL connection:', error);
    console.error('Connection details:', {
      host: dbConfig.host,
      port: dbConfig.port,
      database: dbConfig.database,
      user: dbConfig.user
    });
    throw error;
  }
};

const getConnection = () => {
  if (!pool) {
    throw new Error('Database pool not initialized. Call createConnection() first.');
  }
  return pool;
};

const closeConnection = async () => {
  if (pool) {
    await pool.end();
    console.log('✅ MySQL connection pool closed');
  }
};

module.exports = {
  createConnection,
  getConnection,
  closeConnection
};