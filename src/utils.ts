import * as awsx from '@pulumi/awsx'
import * as pulumi from '@pulumi/pulumi'
import * as aws from '@pulumi/aws'

export const getSubnetIds = (
  subnets: pulumi.Input<awsx.ec2.Subnet[]>,
  name: string,
) =>
  pulumi
    .output(subnets)
    .apply((subnets) =>
      subnets
        .filter((subnet) => subnet.subnetName.includes(`-${name}-`))
        .map((subnet) => subnet.id),
    )
    .apply((subnets) => pulumi.all(subnets))

export const setupAlbListener = (
  lb: awsx.elasticloadbalancingv2.ApplicationLoadBalancer,
  prefix: string,
  port: number,
  protocol: 'HTTPS' | 'HTTP',
  certificateArn?: pulumi.Input<string>,
) =>
  lb.createListener(`${prefix}-${protocol}-${port}-listener`, {
    port,
    protocol,
    defaultAction: {
      type: 'fixed-response',
      fixedResponse: {
        contentType: 'text/plain',
        messageBody: 'You are lost!',
        statusCode: '400',
      },
    },
    certificateArn,
  })

export const setupNlbListener = (
  lb: awsx.elasticloadbalancingv2.NetworkLoadBalancer,
  prefix: string,
  port: number,
  protocol: 'TCP' | 'UDP' | 'TCP_UDP',
  albListener?: awsx.elasticloadbalancingv2.ApplicationListener,
) => {
  const targetGroup = new aws.lb.TargetGroup(
    `${prefix}-${protocol}-${port}-tg`,
    {
      port,
      protocol,
      targetType: albListener ? 'alb' : 'ip',
      vpcId: lb.vpc.id,
    },
  )

  const awsxTargetGroup = lb.createTargetGroup(
    `${prefix}-${protocol}-${port}-awsx-tg`,
    {
      targetGroup,
      port,
    },
  )

  if (albListener) {
    albListener.loadBalancer.loadBalancer.id.apply((targetId) => {
      awsxTargetGroup.attachTarget(
        `${prefix}-${protocol}-${port}-tg-attach`,
        {
          targetId,
        },
        { dependsOn: [albListener] },
      )
    })
  }

  return awsxTargetGroup.createListener(
    `${prefix}-${protocol}-${port}-listener`,
    { port, protocol },
  )
}
