import * as pulumi from '@pulumi/pulumi'
import * as aws from '@pulumi/aws'
import * as awsx from '@pulumi/awsx'

export class UnifiController extends pulumi.ComponentResource {
  webAdminUrl: pulumi.Output<string>

  constructor(
    name: string,
    args: {
      vpc: awsx.ec2.Vpc
      ecsCluster: awsx.ecs.Cluster
      ecsSubnetIds: pulumi.Input<string[]>
      https8443Listener: awsx.elasticloadbalancingv2.ApplicationListener
      https8843Listener: awsx.elasticloadbalancingv2.ApplicationListener
      udp3478Listener: awsx.elasticloadbalancingv2.NetworkListener
      controllerVersion: pulumi.Input<string>
      hostname: pulumi.Input<string>
      zoneId: pulumi.Input<string>
    },
    opts?: pulumi.ComponentResourceOptions,
  ) {
    super('unifi-controller', name, args, opts)

    if (!args.udp3478Listener.defaultTargetGroup) {
      throw new pulumi.RunError('no default target group for listener')
    }

    const nlb = args.udp3478Listener.loadBalancer
    const alb = args.https8443Listener.loadBalancer

    const albWebAdminTargetGroup = alb.createTargetGroup(
      `${name}-alb-web-admin-tg`,
      {
        name: `${name}-alb-8443`,
        port: 8443,
        protocol: 'HTTPS',
        deregistrationDelay: 60,
        healthCheck: {
          protocol: 'HTTPS',
          path: '/',
          matcher: '200,302',
        },
      },
      { parent: this },
    )
    args.https8443Listener.addListenerRule(
      `${name}-alb-web-admin-rule`,
      {
        conditions: [{ hostHeader: { values: [args.hostname] } }],
        actions: [
          {
            type: 'forward',
            targetGroupArn: albWebAdminTargetGroup.targetGroup.arn,
          },
        ],
      },
      { parent: this },
    )

    const albGuestPortalTargetGroup = alb.createTargetGroup(
      `${name}-alb-guest-portal-tg`,
      {
        name: `${name}-alb-8843`,
        port: 8843,
        protocol: 'HTTPS',
        deregistrationDelay: 60,
        healthCheck: {
          protocol: 'HTTPS',
          path: '/',
          port: '8443',
          matcher: '200,302',
        },
      },
      { parent: this },
    )
    args.https8843Listener.addListenerRule(
      `${name}-alb-guest-portal-rule`,
      {
        conditions: [{ hostHeader: { values: [args.hostname] } }],
        actions: [
          {
            type: 'forward',
            targetGroupArn: albGuestPortalTargetGroup.targetGroup.arn,
          },
        ],
      },
      { parent: this },
    )

    for (const dnsType of ['A', 'AAAA']) {
      new aws.route53.Record(
        `${name}-dns-${dnsType}`,
        {
          name: args.hostname,
          type: dnsType,
          aliases: [
            {
              name: nlb.loadBalancer.dnsName,
              zoneId: nlb.loadBalancer.zoneId,
              evaluateTargetHealth: false,
            },
          ],
          zoneId: args.zoneId,
        },
        { parent: this },
      )
    }

    const taskSecurityGroup = new awsx.ec2.SecurityGroup(
      `${name}-fargate-task-sg`,
      {
        vpc: args.vpc,
      },
    )
    awsx.ec2.SecurityGroupRule.ingress(
      `${name}-fargate-task-any-ingress`,
      taskSecurityGroup,
      new awsx.ec2.AnyIPv4Location(),
      new awsx.ec2.AllTraffic(),
      'allow everywhere',
    )
    awsx.ec2.SecurityGroupRule.egress(
      `${name}-fargate-task-any-egress`,
      taskSecurityGroup,
      new awsx.ec2.AnyIPv4Location(),
      new awsx.ec2.AllTraffic(),
      'allow everywhere',
    )

    new awsx.ecs.FargateService(
      `${name}-fargate-service`,
      {
        cluster: args.ecsCluster,
        subnets: args.ecsSubnetIds,
        securityGroups: [taskSecurityGroup],
        assignPublicIp: false,
        healthCheckGracePeriodSeconds: 60,
        taskDefinitionArgs: {
          containers: {
            'unifi-controller': {
              image: `lscr.io/linuxserver/unifi-controller:${args.controllerVersion}`,
              memory: 1024,
              cpu: 1024,
              environment: [
                {
                  name: 'PUID',
                  value: '1000',
                },
                {
                  name: 'PGID',
                  value: '1000',
                },
                {
                  name: 'MEM_LIMIT',
                  value: '1024',
                },
                {
                  name: 'MEM_STARTUP',
                  value: '512',
                },
              ],
              portMappings: [
                albWebAdminTargetGroup,
                albGuestPortalTargetGroup,
                args.udp3478Listener.defaultTargetGroup,
              ],
            },
          },
        },
        desiredCount: 1,
      },
      { parent: this },
    )

    this.webAdminUrl = pulumi.interpolate`https://${args.hostname}:8443`
  }
}
