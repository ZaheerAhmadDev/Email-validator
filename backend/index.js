const express = require("express");
const cors = require("cors");
const multer = require("multer");
const fs = require("fs");
const path = require("path");
const readline = require("readline");
const dns = require("dns");
const net = require("net");
const redis = require("redis");
const { stringify } = require("csv-stringify/sync");

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static("public"));

// Redis Setup
const redisClient = redis.createClient();
redisClient.connect().catch(console.error);

// Multer Setup for file upload
const upload = multer({ dest: "uploads/", limits: { fileSize: 10 * 1024 * 1024 } });

// Validate email format
function isValidEmailSyntax(email) {
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return emailRegex.test(email);
}

// Resolve MX records for domain
function resolveMx(domain) {
  return new Promise((resolve, reject) => {
    dns.resolveMx(domain, (err, addresses) => {
      if (err || !addresses.length) return reject("No MX records found");
      addresses.sort((a, b) => a.priority - b.priority);
      resolve(addresses);
    });
  });
}

// SMTP validation
function checkSMTP(email, mxRecords) {
  return new Promise((resolve) => {
    let index = 0;
    const tryNext = () => {
      if (index >= mxRecords.length) {
        return resolve({ email, valid: false, reason: "All SMTP servers failed" });
      }

      const smtpServer = mxRecords[index++];
      const socket = net.createConnection(25, smtpServer.exchange);

      socket.setTimeout(10000);
      let response = "";

      socket.on("connect", () => {
        socket.write(`HELO example.com\r\n`);
        socket.write(`MAIL FROM:<verify@example.com>\r\n`);
        socket.write(`RCPT TO:<${email}>\r\n`);
        socket.write("QUIT\r\n");
      });

      socket.on("data", (data) => (response += data.toString()));

      socket.on("end", () => {
        if (response.includes("250")) {
          resolve({ email, valid: true, reason: "Valid SMTP response" });
        } else {
          resolve({ email, valid: false, reason: "Email rejected by server" });
        }
      });

      socket.on("error", () => {
        socket.destroy();
        tryNext();
      });

      socket.on("timeout", () => {
        socket.destroy();
        tryNext();
      });
    };

    tryNext();
  });
}

// Replace the existing validateEmail function with this optimized version
async function validateEmail(email) {
  if (!isValidEmailSyntax(email)) {
    return { email, valid: false, reason: "Invalid email format" };
  }

  // Check Redis cache first
  const cached = await redisClient.get(email);
  if (cached) return JSON.parse(cached);

  try {
    const domain = email.split("@")[1];
    
    // Quick domain check without full SMTP validation
    const mxCheck = await resolveMx(domain).catch(() => null);
    if (!mxCheck) {
      const result = { email, valid: false, reason: "No MX records found" };
      await redisClient.setEx(email, 3600, JSON.stringify(result));
      return result;
    }

    // Skip full SMTP check for known domains
    const commonDomains = ['gmail.com', 'yahoo.com', 'hotmail.com', 'outlook.com'];
    if (commonDomains.includes(domain)) {
      const result = { email, valid: true, reason: "Valid domain" };
      await redisClient.setEx(email, 3600, JSON.stringify(result));
      return result;
    }

    const result = await checkSMTP(email, mxCheck);
    await redisClient.setEx(email, 3600, JSON.stringify(result));
    return result;
  } catch (err) {
    const result = { email, valid: false, reason: err };
    await redisClient.setEx(email, 3600, JSON.stringify(result));
    return result;
  }
}

// Single email validation endpoint
app.post("/api/validate-email", async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: "Email is required" });

  const result = await validateEmail(email);
  res.json(result);
});

// Replace the existing upload endpoint with this fixed version
app.post("/api/upload", upload.single("file"), async (req, res) => {
  const startTime = Date.now(); // Add this line at the start
  const BATCH_SIZE = 1000; // Process 1000 emails at once
  const CONCURRENT_BATCHES = 5; // Run 5 batches in parallel
  
  const emails = [];
  const results = [];
  const rl = readline.createInterface({ input: fs.createReadStream(req.file.path) });

  // Read emails from file
  for await (const line of rl) {
    const email = line.trim();
    if (email) emails.push(email);
  }

  // Process in batches
  for (let i = 0; i < emails.length; i += (BATCH_SIZE * CONCURRENT_BATCHES)) {
    const batchPromises = [];
    
    for (let j = 0; j < CONCURRENT_BATCHES; j++) {
      const start = i + (j * BATCH_SIZE);
      const end = start + BATCH_SIZE;
      const batch = emails.slice(start, end);
      
      if (batch.length > 0) {
        batchPromises.push(Promise.all(batch.map(validateEmail)));
      }
    }

    const batchResults = await Promise.all(batchPromises);
    results.push(...batchResults.flat());

    // Update progress
    const progress = ((i + (BATCH_SIZE * CONCURRENT_BATCHES)) / emails.length * 100).toFixed(2);
    console.log(`Progress: ${progress}%`);
  }

  // Generate and save CSV
  const csv = stringify(results, { header: true });
  const csvPath = path.join(__dirname, "public", "results.csv");

  if (!fs.existsSync(path.join(__dirname, "public"))) {
    fs.mkdirSync(path.join(__dirname, "public"));
  }

  fs.writeFileSync(csvPath, csv);
  fs.unlinkSync(req.file.path);

  res.json({ 
    success: true, 
    count: results.length,
    timeElapsed: `${(Date.now() - startTime) / 1000} seconds`
  });
});

// Download endpoint
app.get("/api/download", (req, res) => {
  const file = path.join(__dirname, "public", "results.csv");
  res.download(file, "validated_emails.csv");
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`✅ Server running on http://localhost:${PORT}`));
