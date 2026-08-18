# author

**What.** `workflow`, `adapter`, and the types authors write against (`Ctx`, `Host`). The package's `.` export, re-exported as `penguin`.

**Why.** A workflow file should import one name and nothing else. Author types and Zod stay at this edge so catalog listing and the run process do not.
