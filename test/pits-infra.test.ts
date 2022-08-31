import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import * as PitsInfra from '../lib/pits-infra-stack';

test('Stack Creates Resources', () => {
    const app = new cdk.App();
    const stack = new PitsInfra.PitsInfraStack(app, 'MyTestStack');
    const template = Template.fromStack(stack);

    template.hasResourceProperties('AWS::IAM::Role', {
        RoleName: 'PinTheSkyRole'
    });
});
