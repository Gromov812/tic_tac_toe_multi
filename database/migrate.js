'use strict';

require('dotenv').config();
const fs = require('node:fs/promises');
const path = require('node:path');
const mysql = require('mysql2/promise');

async function migrate() {
  const connection = await mysql.createConnection({
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT || 3306),
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    multipleStatements: true,
  });
  const schema = await fs.readFile(path.join(__dirname, 'schema.sql'), 'utf8');
  await connection.query(schema);
  await connection.query(`INSERT INTO friendships (requester_id, addressee_id, status)
    SELECT f.addressee_id, f.requester_id, 'accepted'
    FROM friendships f
    WHERE f.status = 'accepted'
      AND NOT EXISTS (
        SELECT 1 FROM friendships reverse_f
        WHERE reverse_f.requester_id = f.addressee_id
          AND reverse_f.addressee_id = f.requester_id
      )`);
  await connection.end();
  console.log('Database schema is up to date.');
}

migrate().catch(error => { console.error('Database migration failed:', error.message); process.exitCode = 1; });
