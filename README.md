# Engineer Timewriting Journal Maker

A calendar-style timesheet website for engineers that replaces the
"Engineer timewriting" spreadsheet. Engineers sign in with their own username and password,
pick jobs from the Business Central job list, enter their hours day by day and press **Save**.
They can come back to change a month, or reuse a month's rows for the next one. An **Admin** page lets the
office upload a new Business Central job report and send the journals straight into Business Central (or download them). GitHub Actions build:

- **Timewriting Journal - Sep 2026.csv / .xlsx**: the journal uploaded to Business Central, laid out like the old Journal sheet, and
- **Engineer timewriting - &lt;name&gt; - September 2026.xlsx**: each engineer's month in the old "Timewriting 1-For Engineer" layout.

Website: https://nzosl.github.io/Engineer-Timewriting-Journal-Maker/

## How it fits together

```
 Private data repo (every file encrypted)         Public website repo (this one)
 ────────────────────────────────────────         ──────────────────────────────
 input/report.json (the BC report) ──Action──▶ encrypted job list ──▶ site/data/bundle.enc.json
                                                                       │ GitHub Pages
 Timesheet issues (one per engineer per month) ◀──── Save ────── engineer's browser
        │
        └──Action──▶ output/<tag>.json: the month's journal (.csv + .xlsx) and engineer workbooks,
                     downloaded on the Admin page
```

- **This repo is public.** It holds only the website and the tools, never real data. `.gitignore` blocks spreadsheets and CSVs.
- **Everything private is encrypted**, with keys that come from one secret (`MASTER_KEY`) kept only in GitHub Actions. That includes every file in the private data repo, so even a copy of that repo can't be read without an admin's password or `MASTER_KEY`. Each person has their own keys, unlocked by their password in the browser. The job list is readable by anyone signed in. Each timesheet is end-to-end encrypted for its engineer. Engineers can change their password to one the office never sees. See [SECURITY.md](SECURITY.md) for the full design and what it does and doesn't protect against.
- **Saving** writes the month to an issue in the private data repo, encrypted, using a fine-grained token (Issues only, that repo only) so engineers don't need GitHub accounts. While typing, hours are also kept in the browser, so nothing is lost before Save.
- **The journal** has one line per job and CAPEX/REVEX with hours (hours × the engineer's recharge rate), then a balancing line per engineer to GL 9011. Rates live only in the data repo's encrypted `settings.json`; each engineer's profile carries just their own.

Working with the data repo (updating jobs, rates, downloading journals) is described in [`data-repo-template/README.md`](data-repo-template/README.md).

## Using the website

1. Sign in with your username and password from the office. **My timesheets** lists your months. Open one to change it, or **Delete** one the office hasn't closed (it's taken out of the journal too). **New timesheet** starts another month, empty or with **Copy job template from** an earlier month (the latest, unless you pick another): its jobs and other-time rows, without the hours. Jobs that are closed in Business Central are left out unless **Also copy closed jobs** is ticked. Hold the eye next to the password box to see what you've typed. Forgot it? **Forgot your password?** emails you a link to choose a new one (if the office has your email address).
2. Type a job number (`9683`, `J9683` or `JOB009683`) in **Add a job**. Location, owner and description fill in from the job list and can be edited. The job gets a CAPEX line, a REVEX line or both, depending on which tasks are open in Business Central.
3. Type hours into the days. The search box next to **Jobs** shows only the jobs that match what you type (a number like 9683 or J9683-DU-80, a location, owner or words from the description), to find one quickly. Blank means 0. `7.5`, `7,5` and `7:30` all work. Arrow keys and Enter move between cells, and you can paste a block straight from Excel.
4. Add leave, general time and other non-job rows under **Other time**. These are recorded in your engineer workbook, not the journal.
5. Press **Save** (or Ctrl+S). Jobs with no hours are kept on your timesheet and in your workbook, but only hours go into the journal.
6. **Settings** (top right) shows your account, lets you change your password to one only you know, and shows where password-reset emails go.

**Admins** (listed under `admins` in the data repo's settings) sign in to the **Admin** page, where they can:
- upload a new *Job Task Overview* report, which is checked, saved in the private repo and published to the website within a minute or two;
- add and remove engineers, set each engineer's recharge rate (there's no default rate) and email address (for password resets), and see, copy or reset passwords;
- **Sign in to Business Central**, then **Send to Business Central** on a month (or tick months and send them together) to put the journal into a Job G/L Journal batch (see *Sending journals to Business Central* below);
- download journals and engineer workbooks: **Engineer workbooks** for one month, or tick months for **Download all journal CSVs** and **Download all engineer workbooks** (several months come as one .zip);
- **Close** a month once its journal is in Business Central, which freezes it (with fireworks, as for an engineer's Save);
- **View** an engineer's pages as they see them, read-only (from their saved months; nothing can be changed or saved).

Engineers can copy their jobs and other-time rows from any month they've saved (**New timesheet** on My timesheets). Closed months are read-only and can't be deleted. In the Admin page's **View**, the office can also see each engineer's **Journal preview**.

## Sending journals to Business Central

On the Admin page, **Sign in to Business Central** (above the Journals list), then **Send to Business Central** on a month, puts its journal into a Job G/L Journal batch (Business Central calls it the Project G/L Journal). It runs in the browser: the Admin page signs in to Microsoft in a pop-up and talks to Business Central online directly, through the journal page published as an OData web service. Nothing goes through GitHub, and it can do only what the signed-in person's Business Central user can do. The lines are left in the batch for the office to check and post in Business Central as usual.

Each line of the month's journal CSV becomes a journal line:

| Journal field | Job lines | Balancing line (one per engineer) |
| --- | --- | --- |
| Posting Date | the month's last day | the same |
| Document No. | Document number | the same |
| Account No. (G/L Account) | the G/L account set for CAPEX or REVEX lines | GL (`balancingGlAccount`) |
| Description | Description | the same |
| Amount | GST inclusive (the journal has no GST) | the same (negative) |
| Project No., Project Task No. | Project, Capex/Revex | blank |
| Project Quantity | No. of hours | blank |
| Bal. Account No. | blank | blank |

Signing in also checks the setup: it finds the company (if you only have one), the batch's journal template (from a line already in the batch, then remembers it), the web service and the G/L accounts, and says what's wrong if anything is. **Send to Business Central** then sends the whole month in one go, as one transaction per 100 lines with each engineer's lines kept together. If Business Central refuses a line, none of them is kept and the message names the line. It only stops to ask when the batch already has the month's lines or the month has already been posted. **Undo** takes the lines back out, as long as they haven't been posted.

To set it up once (the Admin page's **Business Central settings** card has the same steps, with this website's exact address):

1. **Register the website with Microsoft.** In the Microsoft Entra admin center: *App registrations › New registration*, single tenant. Under Redirect URI, choose *Single-page application (SPA)* with `https://<this website>/microsoft.html`. Copy the Application (client) ID and Directory (tenant) ID.
2. **Let it use Business Central.** *API permissions › Add a permission › Dynamics 365 Business Central › Delegated › Financials.ReadWrite.All*, then *Grant admin consent*. There's no client secret: the sign-in uses PKCE, as single-page apps do.
3. **Publish the journal page.** In Business Central's *Web Services* page: *New*, Object Type `Page`, Object ID `1020`, Service Name `JobGLJournal`, *Published*.
4. **Fill in Business Central settings** on the Admin page: the Directory (tenant) ID and Application (client) ID, the journal batch, and the G/L accounts for CAPEX and REVEX job lines (the company, journal template, environment and web service name have defaults or are found). **Save**, then **Sign in to Business Central**. Try a sandbox first if you have one (put its name in Environment), or send a month and **Undo** it before posting.

The settings are saved in the private repo's `settings.json` under `businessCentral`. The batch name and G/L accounts only live there, never in this repo.

## Repository layout

| Path | What |
| --- | --- |
| `site/` | The website (plain HTML, CSS and JavaScript modules, no build step). Deployed by `.github/workflows/pages.yml`. |
| `tools/` | Python used by the data repo's Actions: reading the BC report, encrypting the job list, building the journal and workbooks. `etjm_vault.py` lets someone with `MASTER_KEY` look at or change the data repo's encrypted files by hand. |
| `tests/` | Unit tests (`python -m unittest discover -s tests`) using made-up data. |
| `data-repo-template/` | Workflows, settings and README for the private data repo. |
| `relay/` | The reset helper: a Google Apps Script the office runs, which takes "Forgot your password?" requests and sends the reset emails. See [relay/README.md](relay/README.md). |

## Setting it up from scratch

1. Make a `MASTER_KEY`: 32 random bytes, base64 (`python -c "import os,base64;print(base64.b64encode(os.urandom(32)).decode())"`). Keep it in a password manager.
2. Create a private data repo from `data-repo-template/`. With `MASTER_KEY` set in your shell, encrypt the settings and the BC report into it, so nothing is ever committed in the clear:
   `python tools/etjm_vault.py --data-dir DATA import my-settings.json settings.json` and
   `python tools/etjm_vault.py --data-dir DATA import "Job Task Overview - BC report.xlsx" input/report.json`
   (start `my-settings.json` from `settings.example.json`, and don't commit it).
3. Add `MASTER_KEY` to the data repo as a secret. Create an SSH key pair. Add the public half to **this** repo as a deploy key with write access, and the private half to the data repo as the `SITE_DEPLOY_KEY` secret.
4. Create a fine-grained personal access token (Repository access: only the data repo; Permissions: **Issues → Read and write**) and add it to the data repo as `SAVE_TOKEN`. Create a second one with **Contents → Read and write** and **Actions → Read**, for the Admin page, and add it as `ADMIN_TOKEN`.
5. In this repo, set **Settings → Pages → Source** to *GitHub Actions*.
6. Run **Update website and journals** in the data repo.
7. Optional, for **Forgot your password?**: set up the reset helper as in [relay/README.md](relay/README.md), and add email addresses on the Admin page.

## Local development

```sh
python -m pip install --require-hashes --no-deps -r tools/requirements.txt
python -m unittest discover -s tests
python -m http.server -d site 8000   # needs site/data/bundle.enc.json and users.json to sign in
```
