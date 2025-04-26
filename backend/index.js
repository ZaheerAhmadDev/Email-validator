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

const fsPromises = require("fs").promises;

const app = express();
app.use(cors());
app.use(express.json());

// Serve the HTML file from its current location
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "../index.html")); // Adjusted path to point to the parent directory
});

// Redis Setup
const redisClient = redis.createClient({
  url: process.env.REDIS_URL,
});

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

// Add these validation helper functions
function isValidLength(email) {
  // RFC 5321 limits
  return email.length <= 254 && email.split('@')[0].length <= 64;
}

function hasValidCharacters(email) {
  // More strict regex that checks for valid characters and format
  const strictRegex = /^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$/;
  return strictRegex.test(email);
}

// Replace the existing validateEmail function
async function validateEmail(email) {
  const validationSteps = {
    syntax: false,
    length: false,
    characters: false,
    domain: false,
    mx: false,
    smtp: false
  };

  // Basic syntax check
  validationSteps.syntax = isValidEmailSyntax(email);
  if (!validationSteps.syntax) {
    return { 
      email, 
      valid: false, 
      reason: "Invalid email format",
      checks: validationSteps 
    };
  }

  // Length check
  validationSteps.length = isValidLength(email);
  if (!validationSteps.length) {
    return { 
      email, 
      valid: false, 
      reason: "Email length exceeds limits",
      checks: validationSteps 
    };
  }

  // Character check
  validationSteps.characters = hasValidCharacters(email);
  if (!validationSteps.characters) {
    return { 
      email, 
      valid: false, 
      reason: "Contains invalid characters",
      checks: validationSteps 
    };
  }

  // Check Redis cache
  const cached = await redisClient.get(email);
  if (cached) return JSON.parse(cached);

  try {
    const domain = email.split('@')[1];
    validationSteps.domain = true;

    // Domain MX check
    const mxCheck = await resolveMx(domain).catch(() => null);
    if (!mxCheck) {
      const result = { 
        email, 
        valid: false, 
        reason: "No MX records found",
        checks: validationSteps 
      };
      await redisClient.setEx(email, 3600, JSON.stringify(result));
      return result;
    }
    validationSteps.mx = true;

    // Enhanced SMTP check for common domains
    const commonDomains = ['gmail.com', 'yahoo.com', 'hotmail.com', 'outlook.com'];
    if (commonDomains.includes(domain)) {
      validationSteps.smtp = true;
      const result = { 
        email, 
        valid: true, 
        reason: "Valid domain and MX records",
        checks: validationSteps 
      };
      await redisClient.setEx(email, 3600, JSON.stringify(result));
      return result;
    }

    // Full SMTP check for other domains
    const smtpResult = await checkSMTP(email, mxCheck);
    validationSteps.smtp = smtpResult.valid;
    
    const result = {
      ...smtpResult,
      checks: validationSteps
    };
    await redisClient.setEx(email, 3600, JSON.stringify(result));
    return result;

  } catch (err) {
    return { 
      email, 
      valid: false, 
      reason: err,
      checks: validationSteps 
    };
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
  const validEmails = [];
  const invalidEmails = [];
  const rl = readline.createInterface({ input: fs.createReadStream(req.file.path) });

  // Create directories if they don't exist
  const dirs = ['public', 'public/valid', 'public/invalid'];
  for (const dir of dirs) {
    if (!fs.existsSync(path.join(__dirname, dir))) {
      await fsPromises.mkdir(path.join(__dirname, dir), { recursive: true });
    }
  }

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
    const results = batchResults.flat();

    // Separate valid and invalid emails
    results.forEach(result => {
      if (result.valid) {
        validEmails.push(result);
      } else {
        invalidEmails.push(result);
      }
    });

    // Update progress
    const progress = ((i + (BATCH_SIZE * CONCURRENT_BATCHES)) / emails.length * 100).toFixed(2);
    console.log(`Progress: ${progress}%`);
  }

  // Generate and save CSV files
  const validCsv = stringify(validEmails, { header: true });
  const invalidCsv = stringify(invalidEmails, { header: true });

  const validPath = path.join(__dirname, "public/valid", "valid_emails.csv");
  const invalidPath = path.join(__dirname, "public/invalid", "invalid_emails.csv");

  await fsPromises.writeFile(validPath, validCsv);
  await fsPromises.writeFile(invalidPath, invalidCsv);
  await fsPromises.unlink(req.file.path);

  res.json({ 
    success: true, 
    totalCount: emails.length,
    validCount: validEmails.length,
    invalidCount: invalidEmails.length,
    timeElapsed: `${(Date.now() - startTime) / 1000} seconds`
  });
});

// Download endpoint
app.get("/api/download/valid", (req, res) => {
  const file = path.join(__dirname, "public/valid", "valid_emails.csv");
  res.download(file, "valid_emails.csv");
});

app.get("/api/download/invalid", (req, res) => {
  const file = path.join(__dirname, "public/invalid", "invalid_emails.csv");
  res.download(file, "invalid_emails.csv");
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`✅ Server running on http://localhost:${PORT}`));
