# Security Policy

## Supported Versions

Security fixes are handled on the current `main` branch.

## Reporting A Vulnerability

Please do not open a public issue for suspected vulnerabilities, exposed credentials, or abuse paths.

Report security concerns by emailing `celeste@agents.world` with:

- A concise description of the issue.
- Steps to reproduce, if applicable.
- The affected route, file, API, or deployment setting.
- Whether any credential, token, or user data may be exposed.

## Credential Handling

Production deployments should keep private credentials server-side. PlaySG currently does not require private API keys for the playground map or weather planning features.

Google Analytics is configured through the runtime server value `GA_MEASUREMENT_ID`. The client should only receive intentionally public configuration, such as that measurement ID returned from `/api/config`.
