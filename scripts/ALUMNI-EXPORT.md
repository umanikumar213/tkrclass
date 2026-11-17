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
- `needs-review.json`: a partial record and missing field names, only if a profile lacks required details.

The script does not download photos, contact details, attendance, or raw HTML files. It must read the existing student page in memory to extract the allowed fields. Values are read from labeled portal fields, never inferred from the roll number. The course field accepts portal labels such as Course, Programme, or Branch; confirm the college's wording using the first exported record.

Rerun the same command to skip completed students. Keep the same output directory for the same alumni export only. Remove a row from the checkpoint only if you intentionally want to collect it again.

There is one student login at a time, a 10-second pause between students, and at least 2 seconds between HTTP requests. Large exports can take several hours. Ctrl+C requests a stop after the current student is saved. Network failures, rejected logins, 401/403/429 responses, mismatched profiles, captcha/verification pages, and missing fields stop the run. Resolve the cause with the college before resuming.

If the current student page does not show course, section, or year, the script stops rather than guessing. Get a redacted HTML example of the approved profile page (remove all personal data, credentials, and session values) so the parser can be adapted.

Optional flags:

```text
--output generated-artifacts/alumni
--delay-ms 10000
--request-delay-ms 2000
```

Protect the `.txt` input and all exports. The default generated-artifacts directory is excluded from Git and deployment; do not put them in `public/` or upload the directory to a public repository. Files are written with restrictive Unix permissions, but this is not encryption. Do not publish an alumni directory or link student photos until the college's publication/consent rules are settled.
