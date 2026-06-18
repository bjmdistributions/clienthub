Project Execution Plan for Agent
Step 1: Clarifications, Assumptions, and Tradeoffs
Customer Blacklist Feature
Assumption: The database schema for the customer or contact entity requires a new boolean field (e.g., is_blacklisted or is_ghosted, defaulting to false).

Tradeoff: A single button toggle is simple but lacks an audit trail. We will implement it as a direct toggle on the customer profile view without a separate confirmation modal to keep the UI minimal, unless a confirmation is preferred to prevent accidental clicks.

Simplification: We will modify the existing newsletter query logic to globally exclude any customer where this boolean is true.

Search State Persistence Bug
Assumption: The application uses client-side routing (or browser history state) where the search query parameter is currently cleared on navigation.

Tradeoff: We can either persist the search query in the URL as a query parameter (e.g., ?search=name) or store it in the application's global/session state. Utilizing URL query parameters is the standard approach to fix back-button behavior naturally.

Clarification Needed: Does the current search implementation already utilize URL query parameters, or is it driven entirely by local component state?

Custom Contact Forms
Assumption: A "custom form builder" can be overengineered quickly. To adhere to Simplicity First, we assume this means a simple key-value or array configuration in the admin database rather than a drag-and-drop UI editor.

Simplification: The external form will read this schema dynamically, render standard text inputs, and submit the payload to a new staged_contacts table or a contacts table with an approval_status enum set to pending.

Lead Rep Attribution and Split Payouts
Assumption: The application already has an authentication system with a concept of roles (Admin vs. Sales Rep) and an established "deal flow" status pipeline.

Clarification Needed: Is there an existing deals table and a team_settings table where the payout configuration (percentage/flat amount) can be directly added?

Tradeoff: For the weekly briefs, we will append a conditional check based on the authenticated user's role. Admins fetch total aggregates and split data; reps run a filtered query restricted to their rep_id.

Step 2: Goal-Driven Execution Plan
Phase 1: Blacklist and Search Bug Fix
Task 1: Add the blacklist field to the customer schema and implement the toggle button.

Verification: Query a blacklisted user via API or database to verify the flag is true, and verify they are omitted from a mock newsletter distribution list.

Task 2: Fix the search state persistence on back-button navigation.

Verification: Perform a search, navigate to a customer profile, trigger the browser back action, and verify the search input remains populated and the list remains filtered.

Phase 2: Contact Form and Approval Workflow
Task 3: Create the basic dynamic form schema, the public submission endpoint, and the dashboard notification.

Verification: Submit the public form and verify a new record appears in the system with a pending status, triggering the dashboard notification.

Task 4: Create the admin approval action.

Verification: Click approve on the dashboard and verify the contact status updates to active and appears in the primary contact list.

Phase 3: Lead Tracking and Payouts
Task 5: Implement URL parameter tracking on the public form (?rep=id) and map it to the customer record upon submission.

Verification: Submit a form using a specific rep ID parameter and verify the resulting contact record logs that rep as the owner.

Task 6: Add the payout configuration fields to admin settings and the payout inclusion button to the final deal flow step.

Verification: Toggle the payout inclusion button on a mock deal and verify the deal record updates to calculate the split based on current admin settings.

Task 7: Update the weekly brief logic for both admin and client/rep views.

Verification: Log in as an admin to verify visibility of total business splits. Log in as a rep to verify visibility is restricted strictly to personal earnings and individual deal specifics.

Please review this plan. I am waiting for your approval before directing the agent to begin execution.