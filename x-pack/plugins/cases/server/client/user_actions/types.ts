/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

/**
 * Parameters for retrieving user actions for a particular case
 */
export interface UserActionGet {
  /**
   * The ID of the case
   */
  caseId: string;
}

export type GetConnectorsRequest = UserActionGet;
