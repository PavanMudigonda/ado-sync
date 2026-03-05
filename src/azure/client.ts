import { DefaultAzureCredential } from '@azure/identity';
import * as azdev from 'azure-devops-node-api';
import { WebApi } from 'azure-devops-node-api';
import * as CoreApi from 'azure-devops-node-api/CoreApi';
import { IRequestHandler } from 'azure-devops-node-api/interfaces/common/VsoBaseInterfaces';
import * as TestApi from 'azure-devops-node-api/TestApi';
import * as TestPlanApi from 'azure-devops-node-api/TestPlanApi';
import * as WorkItemTrackingApi from 'azure-devops-node-api/WorkItemTrackingApi';

import { SyncConfig } from '../types';

export class AzureClient {
  private connection!: WebApi;
  private _witApi!: WorkItemTrackingApi.IWorkItemTrackingApi;
  private _testPlanApi!: TestPlanApi.ITestPlanApi;
  private _testApi!: TestApi.ITestApi;
  private _coreApi!: CoreApi.ICoreApi;

  private constructor(private config: SyncConfig) {}

  static async create(config: SyncConfig): Promise<AzureClient> {
    const client = new AzureClient(config);
    await client.connect();
    return client;
  }

  private async connect(): Promise<void> {
    const { orgUrl, auth } = this.config;

    let authHandler: IRequestHandler;

    if (auth.type === 'managedIdentity') {
      const credential = new DefaultAzureCredential();
      const token = await credential.getToken(auth.applicationIdURI!);
      authHandler = azdev.getBearerHandler(token.token);
    } else if (auth.type === 'accessToken') {
      authHandler = azdev.getBearerHandler(auth.token!);
    } else {
      // PAT
      authHandler = azdev.getPersonalAccessTokenHandler(auth.token!);
    }

    this.connection = new WebApi(orgUrl, authHandler);
  }

  async getWitApi(): Promise<WorkItemTrackingApi.IWorkItemTrackingApi> {
    if (!this._witApi) this._witApi = await this.connection.getWorkItemTrackingApi();
    return this._witApi;
  }

  async getTestPlanApi(): Promise<TestPlanApi.ITestPlanApi> {
    if (!this._testPlanApi) this._testPlanApi = await this.connection.getTestPlanApi();
    return this._testPlanApi;
  }

  async getTestApi(): Promise<TestApi.ITestApi> {
    if (!this._testApi) this._testApi = await this.connection.getTestApi();
    return this._testApi;
  }

  async getCoreApi(): Promise<CoreApi.ICoreApi> {
    if (!this._coreApi) this._coreApi = await this.connection.getCoreApi();
    return this._coreApi;
  }
}
