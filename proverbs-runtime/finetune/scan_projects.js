#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const os = require('os');

const HOME = '/Users/Stizzop';
const OUTPUT_DIR = path.join(os.homedir(), '.proverbs');
const OUTPUT_FILE = path.join(OUTPUT_DIR, 'projects.json');

// Ensure output directory exists
if (!fs.existsSync(OUTPUT_DIR)) {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
}

const entries = fs.readdirSync(HOME, { withFileTypes: true });
const projects = {};

for (const entry of entries) {
  if (!entry.isDirectory()) continue;

  const dirPath = path.join(HOME, entry.name);

  try {
    const hasPkg = fs.existsSync(path.join(dirPath, 'package.json'));
    const hasGit = fs.existsSync(path.join(dirPath, '.git'));

    if (hasPkg || hasGit) {
      projects[entry.name] = dirPath;
    }
  } catch {
    // skip unreadable dirs
  }
}

fs.writeFileSync(OUTPUT_FILE, JSON.stringify(projects, null, 2));

const count = Object.keys(projects).length;
console.log(`Found ${count} projects. Written to ${OUTPUT_FILE}`);
