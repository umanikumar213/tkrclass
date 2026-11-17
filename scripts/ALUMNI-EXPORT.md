# Standalone alumni export

No webpage is created. Run from the project folder on the college-approved network using Node.js 20+ and the project's existing dependencies. Do not expose this script as a public API.

## Input

Create `generated-artifacts/rolls.txt` locally, with one **college-approved** roll number per line. Blank lines and lines starting with `#` are ignored. Duplicates are removed. This script does not generate or discover accounts.

The login method matches the current attendance application: the roll number is submitted once as both username and password, in a fresh session per student. Use this only where the college explicitly authorizes that access method for the listed students. If passwords differ, do not attempt guesses; obtain an approved export/access method.

## Run

Validate the list without contacting the portal:

```bash
node scripts/export-alumni.js --rolls generated-artifacts/rolls.txt --dry-run
```

Start with **one authorized roll number** to confirm that the portal exposes all five fields:

```bash
node scripts/export-alumni.js --rolls generated-artifacts/rolls.txt --allow-http
```

The default portal URL comes from the existing app. It uses HTTP, which does not encrypt credentials or student data. Prefer an approved HTTPS URL:

```bash
node scripts/export-alumni.js --rolls generated-artifacts/rolls.txt --base-url https://COLLEGE-HOST/TKRCET/
```

Only use `--allow-http` on the trusted college network if HTTP is the college-approved option. Same-origin redirects are allowed; redirects to other hosts are rejected. No captcha bypass, proxy rotation, credential guessing, or automatic login retries.

## Output and resume

Default output directory: `generated-artifacts/alumni/`

- `students.csv`: Excel-compatible CSV with **name, roll_number, course, section, year**.
- `students.json`: the same five fields, used as the resume checkpoint.
- `skipped-rolls.json`: roll numbers where the portal explicitly returned **Invalid Details**, with that reason. These are skipped automatically on resume too.
- `needs-review.json`: a partial record and missing field names, only if a profile lacks required details.

The script does not download photos, contact details, attendance, or raw HTML files. It must read the existing student page in memory to extract the allowed fields. Values are read from labeled portal fields, never inferred from the roll number. The course field accepts portal labels such as Course, Programme, or Branch; confirm the college's wording using the first exported record.

Rerun the same command to skip completed students and previously recorded Invalid Details entries. Keep the same output directory for the same alumni export only. To retry a skipped roll after the college corrects it, close the script, back up `skipped-rolls.json`, and remove only that entry using a JSON-aware editor.

There is one student login at a time, a 10-second pause between students (including skipped entries), and at least 2 seconds between HTTP requests. Large exports can take several hours. Ctrl+C requests a stop after the current student is saved. Explicit **Invalid Details** responses are logged and skipped after one attempt. Other rejected logins, network failures, 401/403/429 responses, mismatched profiles, captcha/verification pages, and missing fields stop the run. Resolve the cause with the college before resuming.

If the current student page does not show course, section, or year, the script stops rather than guessing. Get a redacted HTML example of the approved profile page (remove all personal data, credentials, and session values) so the parser can be adapted.

Optional flags:

```text
--output generated-artifacts/alumni
--delay-ms 10000
--request-delay-ms 2000
```

Protect the `.txt` input and all exports. The default generated-artifacts directory is excluded from Git and deployment; do not put them in `public/` or upload the directory to a public repository. Files are written with restrictive Unix permissions, but this is not encryption. Do not publish an alumni directory or link student photos until the college's publication/consent rules are settled.

## Windows laptop: beginner setup

You do not need to start the website, install PostgreSQL, or copy any deployment secrets.

1. Install the **LTS version of Node.js** from https://nodejs.org, keeping the installer defaults. Close and reopen Command Prompt afterward.
2. Create a folder such as `C:\AlumniExport`. Download/copy `scripts/export-alumni.js` from this project into that folder as `export-alumni.js`. Keep the `.js` extension.
3. Open that folder in File Explorer, click the address bar, type `cmd`, and press Enter. This opens **Command Prompt**, not PowerShell.
4. Check the installation:

   ```bat
   node --version
   npm --version
   ```

5. Install only the dependencies this standalone script needs. This requires internet access, so do it before switching to a restricted college network:

   ```bat
   npm init -y
   npm install axios@1 axios-cookiejar-support@5 cheerio@1.0.0 tough-cookie@4
   ```

6. Open Notepad and put one authorized roll number per line. Start with one for the first check. Choose **Save As**, select **All files**, use UTF-8, and save as `C:\AlumniExport\rolls.txt`. Ensure it is not named `rolls.txt.txt`.
7. In the same Command Prompt window, validate without making network requests:

   ```bat
   node export-alumni.js --rolls rolls.txt --dry-run
   ```

8. Connect to the college-approved private network and run:

   ```bat
   node export-alumni.js --rolls rolls.txt --allow-http
   ```

   This flag permits the existing unencrypted HTTP portal. Use only on the trusted approved network. If given an HTTPS portal URL, use `--base-url https://COLLEGE-HOST/TKRCET/` instead of `--allow-http`.

9. Open `C:\AlumniExport\generated-artifacts\alumni\students.csv` in Excel. Check the first record, especially Course, Section, and Year, before adding the full approved list to `rolls.txt` and running the same command again.
10. Invalid Details entries go to `skipped-rolls.json`; the next roll is processed automatically. Completed and skipped entries are remembered on later runs. Keep the laptop awake and connected. Ctrl+C stops after saving the current attempt.

If Windows says `node is not recognized`, reopen Command Prompt after installation. If `Cannot find module` appears, run the dependency installation command from `C:\AlumniExport` again. If the script cannot find `rolls.txt`, check the filename and that Command Prompt is open in the correct folder.

On Windows, protect the export folder with your account's file permissions; Unix file-mode settings alone do not secure Windows files. Do not share the folder publicly or copy it into the website's `public` folder.
