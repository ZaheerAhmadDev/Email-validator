const fs = require('fs');

// Domains mix (valid and invalid)
const domains = [
    'gmail.com',
    'yahoo.com',
    'hotmail.com',
    'fakezone123.com',
    'nonexistent456.com',
    'invalidomain789.net',
    'testbox.xyz',
    'example.org',
    'fakemail.io',
    'notreal.tech'
];

// Generate random string for email names
function generateRandomString(length) {
    const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
    let result = '';
    for (let i = 0; i < length; i++) {
        result += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return result;
}

// Generate emails
const emails = [];
for (let i = 0; i < 50000; i++) {
    const name = generateRandomString(Math.floor(Math.random() * 10) + 5);
    const domain = domains[Math.floor(Math.random() * domains.length)];
    emails.push(`${name}@${domain}`);
}

// Write to file
fs.writeFileSync('test-emails.txt', emails.join('\n'));
console.log('Generated 50,000 test emails in test-emails.txt');