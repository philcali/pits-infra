# Pits Device Infra

This is currently my cloud infrastructure to influence my "Pi In the Sky" devices
There's really nothing unique to this infra except that it is using a bucket that
I own. With a little work, this can made into a constructs library, or something
a bit more reusable.

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