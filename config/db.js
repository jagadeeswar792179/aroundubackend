// db/pool.js
const { Pool } = require("pg");
const dns = require("dns");
const { URL } = require("url");

function preferIPv4Dns() {
  // Prefer IPv4 when Node supports it (Node >= 17)
  try {
    if (dns.setDefaultResultOrder) dns.setDefaultResultOrder("ipv4first");
  } catch (err) {
    // ignore on older Node versions
  }
}

function buildConnectionStringWithHost(originalConnStr, host) {
  // Build a new connection string replacing the hostname with `host` (can be IPv4)
  // Works with postgres:// or postgresql://
  const url = new URL(originalConnStr);
  url.hostname = host;
  // Ensure we preserve encoded username/password and other parts
  return url.toString();
}

async function resolveIPv4(hostname) {
  return new Promise((resolve, reject) => {
    dns.lookup(hostname, { family: 4 }, (err, address) => {
      if (err) return reject(err);
      resolve(address);
    });
  });
}

function makePool(connectionString) {
  // Create pool with SSL (Supabase requires TLS). rejectUnauthorized:false is common on PaaS.
  return new Pool({
    connectionString,
    ssl: {
      rejectUnauthorized: false,
    },
    // optional: tune pool settings
    max: 10,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 20000,
  });
}

/**
 * createPoolWithIpv4Fallback
 * - Tries to create a Pool using the DATABASE_URL.
 * - If connection fails with ENETUNREACH (IPv6/network unreachable), resolves IPv4 and retries.
 */
async function createPoolWithIpv4Fallback(originalConnStr) {
  preferIPv4Dns();

  let pool = makePool(originalConnStr);

  try {
    // quick health-check query to force a connect attempt and catch immediate errors
    await pool.query("SELECT 1");
    console.log("[db] connected using original host.");
    return pool;
  } catch (err) {
    console.error(
      "[db] initial connection failed:",
      err && err.message ? err.message : err
    );

    // If it's ENETUNREACH (network unreachable), try IPv4 fallback
    if (err && err.code === "ENETUNREACH") {
      try {
        const url = new URL(originalConnStr);
        const hostname = url.hostname;
        console.log(`[db] resolving IPv4 for host ${hostname}...`);
        const ipv4 = await resolveIPv4(hostname);
        console.log(
          `[db] resolved IPv4: ${ipv4} — retrying connection using IPv4 address...`
        );

        const ipv4ConnStr = buildConnectionStringWithHost(
          originalConnStr,
          ipv4
        );

        // close old pool clients
        try {
          await pool.end();
        } catch (e) {
          console.warn(
            "[db] warning closing old pool:",
            e && e.message ? e.message : e
          );
        }

        pool = makePool(ipv4ConnStr);
        await pool.query("SELECT 1");
        console.log("[db] connected using IPv4 address.");
        return pool;
      } catch (ipv4Err) {
        console.error(
          "[db] IPv4 fallback failed:",
          ipv4Err && ipv4Err.message ? ipv4Err.message : ipv4Err
        );
        // rethrow the original or fallback error so app startup can fail cleanly
        throw ipv4Err;
      }
    }

    // If not ENETUNREACH, just rethrow to surface the real error (auth/ssl/etc).
    throw err;
  }
}

let poolPromise = null;

function getPool() {
  if (!poolPromise) {
    const connStr = process.env.DATABASE_URL;
    if (!connStr) {
      throw new Error("DATABASE_URL is not defined in environment");
    }
    poolPromise = createPoolWithIpv4Fallback(connStr);
  }
  return poolPromise;
}

module.exports = { getPool };
