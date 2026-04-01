import fs from 'fs-extra';
import path from 'path';
import 'dotenv/config';

async function copyProfile() {
  const srcDir = process.env.CHROME_USER_DATA_DIR;
  const profile = process.env.CHROME_PROFILE || 'Default';
  const destDir = path.join(process.cwd(), 'temp_chrome_profile');

  if (!srcDir || !fs.existsSync(srcDir)) {
    console.error("Source Chrome directory not found. Check .env.");
    return;
  }

  console.log(`Copying session from ${profile} to temporary folder...`);
  
  try {
    // We only need the specific profile folder and some root files
    const profileSrc = path.join(srcDir, profile);
    const profileDest = path.join(destDir, profile);

    // Create dest if not exists
    if (!fs.existsSync(destDir)) fs.mkdirSync(destDir);

    // Copy "Local State" from root (important for encryption)
    if (fs.existsSync(path.join(srcDir, 'Local State'))) {
       fs.copySync(path.join(srcDir, 'Local State'), path.join(destDir, 'Local State'));
    }

    // Only copy essential session/login files to keep it fast
    const essentialFiles = [
      'Cookies', 'Login Data', 'Local Storage', 'Session Storage', 
      'Web Storage', 'Extension State', 'Preferences', 'Secure Preferences'
    ];

    essentialFiles.forEach(file => {
      const s = path.join(profileSrc, file);
      const d = path.join(profileDest, file);
      if (fs.existsSync(s)) {
        fs.copySync(s, d);
      }
    });

    console.log("Essential session files copied to ./temp_chrome_profile");
  } catch (err) {
    console.error("Error copying profile:", err);
    console.log("Tip: If Chrome is open, some files might be locked. Close Chrome and try again.");
  }
}

copyProfile();
