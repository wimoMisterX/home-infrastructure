import * as pulumi from '@pulumi/pulumi'
import { UnifiController } from './unifi'

const unifiConfig = new pulumi.Config('unifi')

const homeUnifiController = new UnifiController('home-unifi-controller', {
  controllerVersion: unifiConfig.require('controller-version'),
  zoneName: unifiConfig.require('route53-zone-name'),
  hostname: unifiConfig.require('hostname'),
})

export const homeUnifiControllerWebAdminUrl = homeUnifiController.webAdminUrl
