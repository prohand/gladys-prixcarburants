# Security policy

## Supported versions

Only the latest release of the Prix carburants integration receives security fixes.
Update the integration from the Gladys store before reporting an issue.

| Version      | Supported |
| ------------ | --------- |
| 2.x (latest) | Yes       |
| older        | No        |

## Reporting a vulnerability

Please do **not** open a public issue for a security problem.

Report it privately through GitHub: open the **Security** tab of
[prohand/gladys-prixcarburants](https://github.com/prohand/gladys-prixcarburants/security), then
**Report a vulnerability**.

Include, when you can:

- the version of the integration and of Gladys;
- what an attacker can do, and the steps to reproduce it;
- any log line that helps (remove tokens, passwords and addresses first).

You should get a first answer within 7 days. A fix is released as a new version of
the integration, and the advisory is published once users can update.

## Scope

In scope: the code of this repository and the Docker image it publishes.

Out of scope: Gladys Assistant itself (report to
[GladysAssistant/Gladys](https://github.com/GladysAssistant/Gladys/security)) and the
third-party services and APIs this integration talks to.

## Good practices for users

- Keep secrets (tokens, passwords, API keys) only in the integration's secret fields.
- Give the integration accounts the least privileges they need (read-only when possible).
- Keep Gladys and the integration up to date.
