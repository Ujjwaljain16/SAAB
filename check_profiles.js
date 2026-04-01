import fs from 'fs';
import path from 'path';
import os from 'os';

function checkProfiles() {
  const userDataDir = path.join(os.homedir(), 'AppData', 'Local', 'Google', 'Chrome', 'User Data');
  
  if (!fs.existsSync(userDataDir)) {
    console.log('Chrome User Data directory not found.');
    return;
  }

  const files = fs.readdirSync(userDataDir);
  const profiles = files.filter(f => f === 'Default' || f.startsWith('Profile '));

  console.log('\n--- Chrome Profile Inspector ---');
  profiles.forEach(profile => {
    const prefsPath = path.join(userDataDir, profile, 'Preferences');
    if (fs.existsSync(prefsPath)) {
      try {
        const prefs = JSON.parse(fs.readFileSync(prefsPath, 'utf8'));
        const email = prefs.account_info?.[0]?.email || 'No Google Account linked';
        const name = prefs.profile?.name || 'Unnamed Profile';
        
        console.log(`[${profile}]`);
        console.log(`  Name:  ${name}`);
        console.log(`  Email: ${email}`);
        console.log('');
      } catch (e) {
        console.log(`[${profile}] (Could not read preferences)`);
      }
    }
  });
  console.log('-------------------------------\n');
  console.log('Look for the profile that matches your Scaler email and set it in .env!');
}

checkProfiles();
