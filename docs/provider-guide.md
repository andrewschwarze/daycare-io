# Provider Guide

Megan's Daycare  
Everyday tasks  
Updated November 2026

Use this guide to find common provider tasks. Choose a topic below to jump to its instructions. This is a local prototype; use fictional information until production setup and backup checks are complete.

## Contents

- [I want to sign in](#i-want-to-sign-in)
- [I want to see who is here](#i-want-to-see-who-is-here)
- [I want to add a child](#i-want-to-add-a-child)
- [I want to add a family](#i-want-to-add-a-family)
- [I want to change a family's access](#i-want-to-change-a-familys-access)
- [I want to record attendance for a family](#i-want-to-record-attendance-for-a-family)
- [I want to correct an attendance record](#i-want-to-correct-an-attendance-record)
- [I want to download or print attendance](#i-want-to-download-or-print-attendance)
- [I want to reset a family PIN or sign out devices](#i-want-to-reset-a-family-pin-or-sign-out-devices)
- [I want to recover or change the provider password](#i-want-to-recover-or-change-the-provider-password)
- [I want to take attendance during an outage](#i-want-to-take-attendance-during-an-outage)
- [I want to make or restore a backup](#i-want-to-make-or-restore-a-backup)
- [I want to know if the app is ready for real records](#i-want-to-know-if-the-app-is-ready-for-real-records)

## I want to sign in

For provider access, choose **Provider sign in**, then enter the provider email and password. Families enter their shared six-digit PIN on the family sign-in screen. A family can stay signed in on a trusted phone for up to 30 days. Use **Sign out** when finished, especially on a shared phone.

Keep the provider password in a password manager controlled by the daycare. Do not share this login with families. Each family should receive its own PIN privately.

## I want to see who is here

The provider dashboard shows the **Present now** count and each child's attendance status. The **Recent attendance** section shows recent sign-ins and sign-outs. Check this list at opening, during the day, and before closing.

If a child is still shown as present at closing, check what happened and record or correct the event with a clear reason. Do not delete an attendance record.

## I want to add a child

1. Find the **Children** section on the provider dashboard.
2. Enter the child's first and last name.
3. Select **Add child**.

Choose **Edit** beside a child to update the profile. Choose **Deactivate** when the child no longer attends. Deactivation keeps the child's attendance history.

## I want to add a family

1. Find the **Families** section on the provider dashboard.
2. Enter a family display name, such as “Rivera family.”
3. Select all children this family is allowed to manage.
4. Select **Add family and generate PIN**.
5. Copy or write down the PIN shown in the one-time dialog, then select **Done**.

Share the six-digit PIN privately with the verified family. The PIN will not be shown again. Anyone who has the PIN can act for that family, so share it only with authorized adults. Each family must have a separate PIN.

## I want to change a family's access

Choose **Edit** beside the family to change its name or linked children. Choose **Deactivate** to stop its access; this also signs out its remembered devices. Deactivation keeps past attendance records. Reactivate only after confirming the family should have access again.

## I want to record attendance for a family

If a parent cannot use the QR code, find the child in the dashboard and choose **Record sign-in** or **Record sign-out**. Select the family associated with the handoff and enter a short, factual reason. For example: “Provider recorded sign-out after pickup; family forgot to scan.”

The app records the time you submit and shows that you entered it. If you know the handoff happened earlier, record the event and then choose **Correct** to enter the best-known Central Time and explain the change. Say if the time is an estimate. The original time stays in the audit history.

## I want to correct an attendance record

Choose **Correct** beside the event. Replace the details that are wrong, or choose the option to void a duplicate event. Enter a clear reason before saving. The original event stays in the audit history, along with who made the correction and when.

## I want to download or print attendance

Choose **Download CSV** for the full attendance history. Choose **Print report** for a printable view of recent events. The CSV is sensitive: keep it on a device controlled by the daycare and protected with device encryption. Do not email it to a group or put it in a public folder.

The CSV is an app export, not a complete database backup or a state submission form. Times in the CSV are UTC; the printable view shows Central Time.

## I want to reset a family PIN or sign out devices

Verify the family's identity first. In **Families**, choose **Generate new PIN** beside the family. The current PIN stops working and all remembered devices are signed out. Share the replacement PIN privately. The new PIN appears once and cannot be retrieved later.

Choose **Sign out devices** if the family still knows its PIN but needs every remembered phone signed out. This does not change the PIN. Each family member can also use **Sign out** on their own device.

## I want to recover or change the provider password

During initial setup, save the provider recovery phrase somewhere secure and separate from the password. Acknowledge that it has been saved before using the dashboard. You can make a replacement in **Provider account security**; the old phrase stops working when the replacement is acknowledged.

If you forget the provider password, choose **Provider sign in**, then **I need to recover provider access**. Enter the saved recovery phrase and choose a new password. Save and acknowledge the replacement phrase before continuing. A previous one-time recovery code can be used during transition until the new phrase is acknowledged.

If you lose both the provider password and recovery phrase, there is no in-app recovery path. Use the secure paper attendance process and contact the daycare's authorized technical operator. Do not edit credentials directly in the database.

## I want to take attendance during an outage

If the app or internet is unavailable, use the daycare's secure paper attendance process. Write the child, family/adult, sign-in or sign-out, actual time, and the person recording it. Keep the sheet out of public view. Do not put attendance details in a phone notes app or text message.

When the app is working again, enter missing events as the provider and say they came from the outage log. Keep the paper sheet with the daycare's protected records.

## I want to make or restore a backup

**Download CSV** is not a full backup. Full backups and restores require a technical helper and Cloudflare access. Follow the Technical Provider Guide. Backup files contain private information and must be encrypted and stored under the daycare's control.

Do not try a restore yourself. Restoring can replace attendance and account data. Ask the authorized technical operator to confirm the database and restore point first.

## I want to know if the app is ready for real records

Not yet. This is a local prototype with no provider-owned production Cloudflare account or database. A protected provider-owned backup schedule, successful restore drill, and security review are not complete. Use fictional records only until launch work is finished.

## Keep private information private

Do not write passwords, family PINs, API tokens, or recovery phrases in this guide. Share PINs privately with verified family members. Use fictional names in examples and training.
