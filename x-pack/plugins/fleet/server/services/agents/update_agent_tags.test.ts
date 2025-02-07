/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */
import type { SavedObjectsClientContract } from '@kbn/core/server';
import type { ElasticsearchClientMock } from '@kbn/core/server/mocks';
import { elasticsearchServiceMock, savedObjectsClientMock } from '@kbn/core/server/mocks';

import { createClientMock } from './action.mock';
import { updateAgentTags } from './update_agent_tags';
import { updateTagsBatch } from './update_agent_tags_action_runner';

jest.mock('../app_context', () => {
  return {
    appContextService: {
      getLogger: jest.fn().mockReturnValue({
        debug: jest.fn(),
        warn: jest.fn(),
        info: jest.fn(),
        error: jest.fn(),
      } as any),
    },
  };
});

jest.mock('../agent_policy', () => {
  return {
    agentPolicyService: {
      getInactivityTimeouts: jest.fn().mockResolvedValue([]),
      getByIDs: jest.fn().mockResolvedValue([{ id: 'hosted-agent-policy', is_managed: true }]),
      list: jest.fn().mockResolvedValue({ items: [] }),
    },
  };
});

const mockRunAsync = jest.fn().mockResolvedValue({});
jest.mock('./update_agent_tags_action_runner', () => ({
  ...jest.requireActual('./update_agent_tags_action_runner'),
  UpdateAgentTagsActionRunner: jest.fn().mockImplementation(() => {
    return { runActionAsyncWithRetry: mockRunAsync };
  }),
}));

describe('update_agent_tags', () => {
  let esClient: ElasticsearchClientMock;
  let soClient: jest.Mocked<SavedObjectsClientContract>;

  beforeEach(() => {
    esClient = elasticsearchServiceMock.createInternalClient();
    soClient = savedObjectsClientMock.create();
    esClient.search.mockResolvedValue({
      hits: {
        hits: [
          {
            _id: 'agent1',
            _source: {
              tags: ['one', 'two', 'three'],
            },
            fields: {
              status: 'online',
            },
          },
        ],
      },
    } as any);
    esClient.bulk.mockReset();
    esClient.bulk.mockResolvedValue({
      items: [],
    } as any);

    esClient.updateByQuery.mockReset();
    esClient.updateByQuery.mockResolvedValue({ failures: [], updated: 1 } as any);

    mockRunAsync.mockClear();
  });

  it('should remove duplicate tags', async () => {
    await updateAgentTags(soClient, esClient, { agentIds: ['agent1'] }, ['one', 'one'], ['two']);

    expect(esClient.updateByQuery).toHaveBeenCalledWith(
      expect.objectContaining({
        conflicts: 'proceed',
        index: '.fleet-agents',
        query: { terms: { _id: ['agent1'] } },
        script: expect.objectContaining({
          lang: 'painless',
          params: expect.objectContaining({
            tagsToAdd: ['one'],
            tagsToRemove: ['two'],
            updatedAt: expect.anything(),
          }),
          source: expect.anything(),
        }),
      })
    );
  });

  it('should update action results on success', async () => {
    esClient.updateByQuery.mockReset();
    esClient.updateByQuery.mockResolvedValue({ failures: [], updated: 1, total: 1 } as any);

    await updateAgentTags(soClient, esClient, { agentIds: ['agent1'] }, ['one'], []);

    const agentAction = esClient.create.mock.calls[0][0] as any;
    expect(agentAction?.body).toEqual(
      expect.objectContaining({
        action_id: expect.anything(),
        agents: ['agent1'],
        type: 'UPDATE_TAGS',
        total: 1,
      })
    );

    const actionResults = esClient.bulk.mock.calls[0][0] as any;
    const agentIds = actionResults?.body
      ?.filter((i: any) => i.agent_id)
      .map((i: any) => i.agent_id);
    expect(agentIds).toEqual(['agent1']);
    expect(actionResults.body[1].error).not.toBeDefined();
  });

  it('should update action results on success - kuery', async () => {
    await updateTagsBatch(
      soClient,
      esClient,
      [],
      {},
      {
        tagsToAdd: ['new'],
        tagsToRemove: [],
        kuery: '',
      }
    );

    const actionResults = esClient.bulk.mock.calls[0][0] as any;
    const agentIds = actionResults?.body
      ?.filter((i: any) => i.agent_id)
      .map((i: any) => i.agent_id);
    expect(agentIds[0]).toHaveLength(36); // uuid
    expect(actionResults.body[1].error).not.toBeDefined();
  });

  it('should skip hosted agent from total when agentIds are passed', async () => {
    const { esClient: esClientMock, agentInHostedDoc } = createClientMock();

    esClientMock.updateByQuery.mockReset();
    esClientMock.updateByQuery.mockResolvedValue({ failures: [], updated: 0, total: 0 } as any);

    await updateAgentTags(
      soClient,
      esClientMock,
      { agentIds: [agentInHostedDoc._id] },
      ['newName'],
      []
    );

    const agentAction = esClientMock.create.mock.calls[0][0] as any;
    expect(agentAction?.body).toEqual(
      expect.objectContaining({
        action_id: expect.anything(),
        agents: [],
        type: 'UPDATE_TAGS',
        total: 0,
      })
    );
  });

  it('should write error action results when failures are returned', async () => {
    esClient.updateByQuery.mockReset();
    esClient.updateByQuery.mockResolvedValue({
      failures: [{ cause: { reason: 'error reason' } }],
      updated: 0,
    } as any);

    await updateAgentTags(soClient, esClient, { agentIds: ['agent1'] }, ['one'], []);

    const errorResults = esClient.bulk.mock.calls[0][0] as any;
    expect(errorResults.body[1].error).toEqual('error reason');
  });

  it('should throw error on version conflicts', async () => {
    esClient.updateByQuery.mockReset();
    esClient.updateByQuery.mockResolvedValue({
      failures: [],
      updated: 0,
      version_conflicts: 100,
    } as any);

    await expect(
      updateAgentTags(soClient, esClient, { agentIds: ['agent1'] }, ['one'], [])
    ).rejects.toThrowError('version conflict of 100 agents');
  });

  it('should write out error results on last retry with version conflicts', async () => {
    esClient.updateByQuery.mockReset();
    esClient.updateByQuery.mockResolvedValue({
      failures: [],
      updated: 0,
      version_conflicts: 100,
    } as any);

    await expect(
      updateTagsBatch(
        soClient,
        esClient,
        [],
        {},
        {
          tagsToAdd: ['new'],
          tagsToRemove: [],
          kuery: '',
          total: 100,
          retryCount: 5,
        }
      )
    ).rejects.toThrowError('version conflict of 100 agents');
    const errorResults = esClient.bulk.mock.calls[0][0] as any;
    expect(errorResults.body[1].error).toEqual('version conflict on last retry');
  });

  it('should run add tags async when actioning more agents than batch size', async () => {
    esClient.search.mockResolvedValue({
      hits: {
        total: 3,
        hits: [
          {
            _id: 'agent1',
            _source: {},
          } as any,
          {
            _id: 'agent2',
            _source: {},
          } as any,
          {
            _id: 'agent3',
            _source: {},
          } as any,
        ],
      },
      took: 0,
      timed_out: false,
      _shards: {} as any,
    });

    await updateAgentTags(soClient, esClient, { kuery: '', batchSize: 2 }, ['newName'], []);

    expect(mockRunAsync).toHaveBeenCalled();
  });

  it('should add tags filter if only one tag to add', async () => {
    await updateTagsBatch(
      soClient,
      esClient,
      [],
      {},
      {
        tagsToAdd: ['new'],
        tagsToRemove: [],
        kuery: '',
      }
    );

    const updateByQuery = esClient.updateByQuery.mock.calls[0][0] as any;
    expect(updateByQuery.query).toMatchInlineSnapshot(`
      Object {
        "bool": Object {
          "filter": Array [
            Object {
              "bool": Object {
                "must_not": Object {
                  "bool": Object {
                    "minimum_should_match": 1,
                    "should": Array [
                      Object {
                        "bool": Object {
                          "minimum_should_match": 1,
                          "should": Array [
                            Object {
                              "match": Object {
                                "status": "inactive",
                              },
                            },
                          ],
                        },
                      },
                      Object {
                        "bool": Object {
                          "minimum_should_match": 1,
                          "should": Array [
                            Object {
                              "match": Object {
                                "status": "unenrolled",
                              },
                            },
                          ],
                        },
                      },
                    ],
                  },
                },
              },
            },
            Object {
              "bool": Object {
                "must_not": Object {
                  "bool": Object {
                    "minimum_should_match": 1,
                    "should": Array [
                      Object {
                        "match": Object {
                          "tags": "new",
                        },
                      },
                    ],
                  },
                },
              },
            },
          ],
        },
      }
    `);
  });

  it('should add tags filter if only one tag to remove', async () => {
    await updateTagsBatch(
      soClient,
      esClient,
      [],
      {},
      {
        tagsToAdd: [],
        tagsToRemove: ['remove'],
        kuery: '',
      }
    );

    const updateByQuery = esClient.updateByQuery.mock.calls[0][0] as any;
    expect(JSON.stringify(updateByQuery.query)).toContain(
      '{"bool":{"should":[{"match":{"tags":"remove"}}],"minimum_should_match":1}}'
    );
  });

  it('should write total from updateByQuery result if query returns less results', async () => {
    esClient.updateByQuery.mockReset();
    esClient.updateByQuery.mockResolvedValue({ failures: [], updated: 0, total: 50 } as any);

    await updateTagsBatch(
      soClient,
      esClient,
      [],
      {},
      {
        tagsToAdd: ['new'],
        tagsToRemove: [],
        kuery: '',
        total: 100,
      }
    );

    const agentAction = esClient.create.mock.calls[0][0] as any;
    expect(agentAction?.body).toEqual(
      expect.objectContaining({
        action_id: expect.anything(),
        agents: [],
        type: 'UPDATE_TAGS',
        total: 50,
      })
    );
  });
});
