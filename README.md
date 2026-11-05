# Church Management System for Netlify

The web page, the login system and the data storage all run on Netlify.
No separate server and no database to set up. Records are kept in Netlify Blobs.

## Put it online (about 10 minutes)

1. Create a free account at github.com and make a new **private** repository.
   Upload everything in this folder to it (the folders `public`, `netlify`, `test` and the files `netlify.toml`, `package.json`).
2. In Netlify choose **Add new site > Import an existing project**, pick GitHub and select the repository.
   Leave the build command empty. The publish folder (`public`) is read from `netlify.toml`.
3. Before deploying, open **Site configuration > Environment variables** and add

       ADMIN_PASSWORD = a long temporary password you choose

   Tick "Contains secret values" if offered. Optional: `CHURCH_NAME = Presbyterian Church of Ghana, Grace Congregation`.
4. Deploy. Open your site address, choose **Staff login**, enter `admin` and your `ADMIN_PASSWORD`.
   You are asked to choose your own password straight away. After that the `ADMIN_PASSWORD` value is no longer used.
5. In **Domain management** you can add your own web address. HTTPS is automatic.

## Logging in

* **Staff** use a username and password. Administrators create staff accounts under Users. A new account must pick its own password at first login.
* **Members** use their Member ID and an 8-character access code. An administrator creates it under Members > Create code
  (or "Create missing access codes" for everyone). Codes are stored only as hashes and are shown once, so give the code to the member at that moment.
* Members see only their own details and attendance.
* Only administrators can create codes and accounts, change settings, download or restore backups, and clear records.

## Security notes

* Passwords and codes are stored as scrypt hashes. Sessions are random tokens in HttpOnly, Secure, SameSite=Strict cookies (staff 12 hours, member 4 hours).
* Repeated wrong guesses lock that account for a growing time.
* Changing a password, resetting or removing a member code, or deleting a member ends their open sessions.
* Keep the GitHub repository private. Do not put real member data or passwords into it.

## Backups

Settings > Download backup gives a JSON file of all records and password hashes. Do this regularly and keep the file private.
Settings > Restore from backup puts it back.

## If the administrator password is lost

In Netlify open **Blobs** (Site configuration or the Blobs page), open the store `church`, delete the entry `d/users`, and sign in again
with `admin` and the current `ADMIN_PASSWORD` value. All staff accounts are removed by this, member records stay.

## Limits to know about

* Records are saved as a few JSON documents. This suits a congregation of several thousand members with a few staff members.
  If two staff members save the same kind of record at the very same second, the later save can overwrite the earlier one.
* Each request must stay under about 5 MB, so keep the logo under 600 KB.
* Netlify's free plan has monthly usage limits for functions. A single congregation is far below them.

## Try it on your own computer

Needs Node.js 20 or newer. This preview keeps data in a local file and does not need Netlify:

    ADMIN_PASSWORD=MyTempPass1 node test/dev-server.mjs

Open http://localhost:8888. Run the automated checks with `node test/api.test.mjs`.
