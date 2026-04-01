import fs from 'fs';
import path from 'path';
import os from 'os';

function findChrome() {
  let userDataDir = '';
  const platform = os.platform();

  if (platform === 'win32') {
    userDataDir = path.join(os.homedir(), 'AppData', 'Local', 'Google', 'Chrome', 'User Data');
  } else if (platform === 'darwin') {
    userDataDir = path.join(os.homedir(), 'Library', 'Application Support', 'Google', 'Chrome');
  } else {
    userDataDir = path.join(os.homedir(), '.config', 'google-chrome');
  }

  console.log('\n--- Chrome Path Discovery ---');
  if (fs.existsSync(userDataDir)) {
    console.log(`Detected Chrome User Data Directory: ${userDataDir}`);
    
    // Suggest .env update
    console.log(`\nAdd this to your .env:`);
    console.log(`CHROME_USER_DATA_DIR="${userDataDir}"`);

    // List potential profiles
    const files = fs.readdirSync(userDataDir);
    const profiles = files.filter(f => f === 'Default' || f.startsWith('Profile '));
    
    if (profiles.length > 0) {
      console.log(`\nAvailable Profiles:`);
      profiles.forEach(p => console.log(`- ${p}`));
      console.log(`\nRecommendation: Set CHROME_PROFILE="${profiles[0]}" in .env and adjust if it's the wrong account.`);
    }
  } else {
    console.log(`Error: Could not find Chrome User Data directory at ${userDataDir}`);
    console.log('Please locate your "User Data" folder and set it in CHROME_USER_DATA_DIR in .env');
  }
  console.log('----------------------------\n');
}

findChrome();
