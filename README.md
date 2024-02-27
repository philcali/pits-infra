# Pits Device Infra

[![Node.js CI](https://github.com/philcali/pits-infra/actions/workflows/node.js.yml/badge.svg)](https://github.com/philcali/pits-infra/actions/workflows/node.js.yml)
[![CodeQL](https://github.com/philcali/pits-infra/actions/workflows/codeql-analysis.yml/badge.svg)](https://github.com/philcali/pits-infra/actions/workflows/codeql-analysis.yml)

This is currently my cloud infrastructure to influence my "Pi In the Sky" devices
There's really nothing unique to this infra except that it is using a bucket that
I own. With a little work, this can made into a constructs library, or something
a bit more reusable.

## Re-use

Replace the `const` fields in `constants.ts` to make the infrastructure
your own. The project assumes you have purchases a domain name through
AWS and created an associated ACM wilcard. The price of a hosted zone
in AWS will be 50 cents. By replacing the certificate
and zone information to `undefined`, the infrastructure will assume
auto generated domain names for Cognito, API gateway, and Cloudfront
distributions, and will be largely free of charge.

## Resources

- S3 bucket for video storage
- AWS IoT Thing Policy for remote control, configuration, and updates
- AWS IAM Role, allows X509 authentication on the device for AWS credentials
- AWS IAM Managed Policy, allows the device to upload videos
- AWS IoT Role Alias, for the credentials provider to assume the role

That's it currently. There will be more to come for notifications, rules engines,
and other such automation.

## Deploying

```
npm run test
cdk diff
cdk deploy
```

Done-zo.