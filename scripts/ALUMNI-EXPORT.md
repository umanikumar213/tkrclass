# Standalone alumni export

No webpage is created. Run from the project folder on the college-approved network using Node.js 20+ and the project's existing dependencies. Do not expose this script as a public API.

## Input

Create `generated-artifacts/rolls.txt` locally, with one **college-approved** series prefix (8 characters) or full roll number (10 characters) per line. Blank lines and lines starting with `#` are ignored. Duplicates are removed, including overlap between full roll numbers and expanded series.

Example series file:

```text
23K91A67
24K95A67
24K91A67
25K95A67
```

Each prefix expands to suffixes **00–99, A0–A9, B0–B9, …, Z0–Z9**, including A1. That is **360 candidates per prefix**, or **1,440 for these four prefixes**. These are candidate roll numbers, not a count of students who actually exist. Use prefixes only when the college has authorized collection for the entire series. Run `--dry-run` first to check the total without contacting the portal.

The login method matches the current attendance application: the roll number is submitted once as both username and password, in a fresh session per student. Use this only where the college explicitly authorizes that access method for the listed students. If passwords differ, do not attempt guesses; obtain an approved export/access method.

## Run

Validate the list without contacting the portal:

```bash
node scripts/export-alumni.js --rolls generated-artifacts/rolls.txt --dry-run
```

Start with **one authorized roll number** to confirm that the portal exposes the five required profile fields and check any optional contact fields:

```bash
node scripts/export-alumni.js --rolls generated-artifacts/rolls.txt --allow-http
```

The default portal URL comes from the existing app. It uses HTTP, which does not encrypt credentials or student data. Prefer an approved HTTPS URL:

```bash
node scripts/export-alumni.js --rolls generated-artifacts/rolls.txt --base-url https://COLLEGE-HOST/TKRCET/
```

Only use `--allow-http` on the trusted college network if HTTP is the college-approved option. Same-origin redirects are allowed; redirects to other hosts are rejected. No captcha bypass, proxy rotation, or credential guessing. Only temporary connection failures and HTTP 500/502/503/504 responses get one fresh-session retry after 60 seconds.

## Output and resume

Default output directory: `generated-artifacts/alumni/`

- `students.csv`: Excel-compatible CSV with **name, roll_number, course, section, year, student_mobile, father_name**.
- `students.json`: the same seven fields, used as the resume checkpoint.
- `skipped-rolls.json`: roll numbers where the portal explicitly returned **Invalid Details**, with that reason. These are skipped automatically on resume too.
- `network-failures.json`: entries that failed both the initial attempt and the 60-second retry. They are skipped for the current run, but automatically tried again when you rerun the same command. Resolved entries are removed from this log.
- `needs-review.json`: a partial record and missing field names, only if a profile lacks required details.
- `incomplete-profiles.json`: all entries still missing required profile fields after one 60-second retry. They are not marked completed and will be tried again on the next run.

The script collects only the seven listed fields, not photos, parent phone numbers, email, attendance, or raw HTML files. It must read the existing student page in memory to extract the allowed fields. Values are read from labeled portal fields, never inferred from the roll number. The course field accepts portal labels such as Course, Programme, or Branch; confirm the college's wording using the first exported record.

**Student mobile and father's name are optional.** Missing/unavailable values stay blank and do not stop the run. Only explicit student-specific phone labels (such as `Student Mobile`) are accepted; a generic Mobile or Father Mobile field is not substituted. Phone values remain strings in JSON, preserving leading zeroes and formatting. When importing CSV into Excel, set `student_mobile` to Text to avoid Excel's automatic number conversion.

Existing five-field checkpoints are backed up automatically before the two blank columns are added. Already saved students are still skipped; they are not logged into again to backfill these details. New students receive the extra values when present. Keep these contact details private and use them only for college-approved purposes; do not publish the contact fields on a public alumni directory.

Rerun the same command to skip completed students and previously recorded Invalid Details entries. Keep the same output directory for the same alumni export only. To retry a skipped roll after the college corrects it, close the script, back up `skipped-rolls.json`, and remove only that entry using a JSON-aware editor.

There is one student login at a time and **no added pause between students**, including skipped entries. Requests within each student's session remain spaced at least 2 seconds apart by default. Large exports can still take hours. Ctrl+C stops after the current student is saved; during a retry countdown, it cancels the retry. Explicit **Invalid Details** responses are logged and skipped immediately. Temporary network failures, HTTP 500/502/503/504 responses, and incomplete matching profiles wait **60 seconds**, then retry once with a fresh session. A second recoverable failure is logged and the run moves to the next student. Other rejected logins, redirect errors, 401/403/429 responses, mismatched roll numbers, and captcha/verification pages still stop the run. Resolve those causes with the college before resuming. Check `network-failures.json` and `incomplete-profiles.json` for outstanding records and rerun later to retry them.

If a matching student page is missing required name/course/section/year details, the script waits 60 seconds and retries once. If still incomplete, it records the partial profile in `incomplete-profiles.json` (and the latest one in `needs-review.json`), then continues to the next roll. It never saves these as complete students or fills missing values by guessing. Successfully recovered entries are removed from the incomplete log. Optional mobile/father-name blanks do not trigger this retry. If many entries fail in the same way, stop the run and obtain a redacted HTML example of the approved profile page so the parser can be adapted.

Optional flags:

```text
--output generated-artifacts/alumni
--delay-ms 0
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

6. Open Notepad and put one authorized series prefix or full roll number per line. Start with one full roll number for the first check, then replace it with your approved series prefixes. Choose **Save As**, select **All files**, use UTF-8, and save as `C:\AlumniExport\rolls.txt`. Ensure it is not named `rolls.txt.txt`.
7. In the same Command Prompt window, validate without making network requests:

   ```bat
   node export-alumni.js --rolls rolls.txt --dry-run
   ```

8. Connect to the college-approved private network and run:

   ```bat
   node export-alumni.js --rolls rolls.txt --allow-http
   ```

   This flag permits the existing unencrypted HTTP portal. Use only on the trusted approved network. If given an HTTPS portal URL, use `--base-url https://COLLEGE-HOST/TKRCET/` instead of `--allow-http`.

9. Open `C:\AlumniExport\generated-artifacts\alumni\students.csv` in Excel after stopping the script. Check the first record, especially Course, Section, Year and the optional Student Mobile/Father Name fields, before adding the full approved list to `rolls.txt` and running the same command again.
10. Invalid Details entries go to `skipped-rolls.json`; the next roll is processed automatically. Completed and skipped entries are remembered on later runs. Keep the laptop awake and connected. Ctrl+C stops after saving the current attempt.

If Windows says `node is not recognized`, reopen Command Prompt after installation. If `Cannot find module` appears, run the dependency installation command from `C:\AlumniExport` again. If the script cannot find `rolls.txt`, check the filename and that Command Prompt is open in the correct folder.

### Excel locks and repairing old exports

Close `students.csv` in Excel while collecting. If Windows blocks replacing it (`EPERM`, `EACCES`, or `EBUSY`), the updated script continues saving the canonical `students.json` and warns that the CSV is stale. Close Excel, then rerun the same command to rebuild the CSV from saved JSON without repeating completed logins.

Older script versions could mistake attendance-table headings for profile values, saving Section=`Status` or Year=`Semester`. The updated script detects these exact placeholder values for rolls in your current input list, backs up the original checkpoint as `students-before-repair-<timestamp>.json`, and re-collects the affected records. Keep your original full input list to repair all affected entries. Do not delete the output folder or checkpoint. Check one corrected export before continuing a full batch; if fields remain missing, stop and provide a redacted HTML example of the profile header.

On Windows, protect the export folder with your account's file permissions; Unix file-mode settings alone do not secure Windows files. Do not share the folder publicly or copy it into the website's `public` folder.
