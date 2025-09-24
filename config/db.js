// src/config/db.js
// CommonJS module that exports: { query, getPool }
const { Pool } = require("pg");
const dns = require("dns");
const { URL } = require("url");

function preferIPv4Dns() {
  try {
    if (dns.setDefaultResultOrder) dns.setDefaultResultOrder("ipv4first");
  } catch (e) {
    // ignore on older Node versions
  }
}

function buildConnectionStringWithHost(originalConnStr, host) {
  const url = new URL(originalConnStr);
  url.hostname = host;
  return url.toString();
}

function resolveIPv4(hostname) {
  return new Promise((resolve, reject) => {
    dns.lookup(hostname, { family: 4 }, (err, address) => {
      if (err) return reject(err);
      resolve(address);
    });
  });
}

function makePool(connectionString) {
  return new Pool({
    connectionString,
    ssl: {
      // PaaS environment: accept server cert (commonly used)
      rejectUnauthorized: false,
    },
    max: 10,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 20000,
  });
}

async function createPoolWithIpv4Fallback(originalConnStr) {
  preferIPv4Dns();

  let pool = makePool(originalConnStr);

  try {
    // Force a quick connect attempt
    await pool.query("SELECT 1");
    console.log("[db] connected using original host");
    return pool;
  } catch (err) {
    console.error(
      "[db] initial connection failed:",
      err && err.message ? err.message : err
    );

    if (err && err.code === "ENETUNREACH") {
      // try IPv4 fallback
      try {
        const url = new URL(originalConnStr);
        const hostname = url.hostname;
        console.log(`[db] resolving IPv4 for ${hostname}...`);
        const ipv4 = await resolveIPv4(hostname);
        console.log(`[db] resolved IPv4: ${ipv4}`);
        const ipv4ConnStr = buildConnectionStringWithHost(
          originalConnStr,
          ipv4
        );

        // close the previous pool (best effort)
        try {
          await pool.end();
        } catch (e) {
          console.warn(
            "[db] error closing old pool:",
            e && e.message ? e.message : e
          );
        }

        pool = makePool(ipv4ConnStr);
        await pool.query("SELECT 1");
        console.log("[db] connected using IPv4 address");
        return pool;
      } catch (ipv4Err) {
        console.error(
          "[db] IPv4 fallback failed:",
          ipv4Err && ipv4Err.message ? ipv4Err.message : ipv4Err
        );
        throw ipv4Err;
      }
    }

    // rethrow other errors (auth/ssl/etc) to surface them
    throw err;
  }
}

// lazy init
let poolPromise = null;
async function getPool() {
  if (!poolPromise) {
    const connStr = process.env.DATABASE_URL;
    if (!connStr) throw new Error("DATABASE_URL not set in environment");
    poolPromise = createPoolWithIpv4Fallback(connStr);
  }
  return poolPromise;
}

// convenience query wrapper used by your controllers:
async function query(text, params) {
  const pool = await getPool();
  return pool.query(text, params);
}

module.exports = { query, getPool };
