import {
  IAgentScopeRuntimeWebUISession,
  IAgentScopeRuntimeWebUISessionAPI,
} from '@agentscope-ai/chat';

// AgentScope 2.0 API 端点 (相对于 baseURL)
// const API_BASE = '';

// Session 创建回调,用于通知外部组件
let onSessionCreated: ((sessionId: string) => void) | null = null;

export function setSessionCreatedCallback(callback: (sessionId: string) => void) {
  onSessionCreated = callback;
}

class SessionApi implements IAgentScopeRuntimeWebUISessionAPI {
  private lsKey: string;
  private sessionList: IAgentScopeRuntimeWebUISession[];
  private agentId: string | null = null;
  private credentialId: string | null = null;

  constructor() {
    this.lsKey = 'agentscope2-webui-sessions';
    this.sessionList = [];
  }

  // 获取或创建 Credential
  async getOrCreateCredential(baseURL: string): Promise<string> {
    if (this.credentialId) {
      return this.credentialId;
    }

    const headers = {
      'Content-Type': 'application/json',
      'x-user-id': 'webui-user',
    };

    // 创建新 Credential
    try {
      const createResponse = await fetch(`${baseURL}/credential/`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          data: {
            type: 'openai_credential',
            api_key: 'sk-sp-95fdb787d3794bc7924b2f3dc5e9b625',
            base_url: 'https://coding.dashscope.aliyuncs.com/v1',
          },
        }),
      });

      if (createResponse.ok) {
        const data = await createResponse.json();
        this.credentialId = data.credential_id;
        console.log('[SessionApi] Credential created:', this.credentialId);
        return this.credentialId!;
      } else {
        const error = await createResponse.text();
        console.error('[SessionApi] Failed to create credential:', error);
      }
    } catch (e) {
      console.error('[SessionApi] Failed to create credential:', e);
    }

    throw new Error('Failed to create credential');
  }

  // 获取或创建 Agent
  async getOrCreateAgent(baseURL: string): Promise<string> {
    if (this.agentId) {
      return this.agentId;
    }

    // 先创建 credential
    const credentialId = await this.getOrCreateCredential(baseURL);

    const headers = {
      'Content-Type': 'application/json',
      'x-user-id': 'webui-user',
    };

    // 创建新 Agent
    try {
      const createResponse = await fetch(`${baseURL}/agent/`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          name: 'AgentScope2Expert',
          system_prompt: '你是 AgentScope2 框架专家',
          context_config: {},
          react_config: { max_iters: 50 },
          model: {
            type: 'openai',
            config: {
              model: 'qwen3.6-plus',
              credential_id: credentialId,
            },
          },
        }),
      });

      if (createResponse.ok) {
        const data = await createResponse.json();
        this.agentId = data.agent_id;
        console.log('[SessionApi] Agent created:', this.agentId);
        return this.agentId!;
      } else {
        const error = await createResponse.text();
        console.error('[SessionApi] Failed to create agent:', error);
      }
    } catch (e) {
      console.error('[SessionApi] Failed to create agent:', e);
    }

    throw new Error('Failed to create agent');
  }

  // 创建 Session (AgentScope 2.0 需要)
  async createSessionInBackend(baseURL: string, sessionId: string): Promise<string> {
    if (!this.agentId) {
      throw new Error('Agent ID is not set');
    }

    const credentialId = this.credentialId || await this.getOrCreateCredential(baseURL);

    const headers = {
      'Content-Type': 'application/json',
      'x-user-id': 'webui-user',
    };

    try {
      const response = await fetch(`${baseURL}/sessions/`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          agent_id: this.agentId,
          name: `Session ${sessionId}`,
          chat_model_config: {
            type: 'openai',
            credential_id: credentialId,
            model: 'qwen3.6-plus',
            parameters: {},
          },
        }),
      });

      if (response.ok) {
        const data = await response.json();
        console.log('[SessionApi] Session created in backend:', data.session_id);
        return data.session_id;
      } else {
        const error = await response.text();
        console.error('[SessionApi] Failed to create session in backend:', error);
        throw new Error(`Failed to create session: ${error}`);
      }
    } catch (e) {
      console.error('[SessionApi] Failed to create session in backend:', e);
      throw e;
    }
  }

  async getSessionList() {
    this.sessionList = JSON.parse(localStorage.getItem(this.lsKey) || '[]');
    return [...this.sessionList];
  }

  async getSession(sessionId: string) {
    return this.sessionList.find((session) => session.id === sessionId) as IAgentScopeRuntimeWebUISession;
  }

  async updateSession(session: Partial<IAgentScopeRuntimeWebUISession>) {
    const index = this.sessionList.findIndex((item) => item.id === session.id);
    if (index > -1) {
      this.sessionList[index] = {
        ...this.sessionList[index],
        ...session,
      };
      localStorage.setItem(this.lsKey, JSON.stringify(this.sessionList));
    }

    return [...this.sessionList];
  }

  async createSession(session: Partial<IAgentScopeRuntimeWebUISession>) {
    // 生成 session ID
    session.id = Date.now().toString();

    console.log('[SessionApi] createSession, id:', session.id);

    this.sessionList.unshift(session as IAgentScopeRuntimeWebUISession);
    localStorage.setItem(this.lsKey, JSON.stringify(this.sessionList));

    // 通知外部组件 session 已创建
    if (onSessionCreated && session.id) {
      console.log('[SessionApi] Calling onSessionCreated callback');
      onSessionCreated(session.id);
    }

    return [...this.sessionList];
  }

  async removeSession(session: Partial<IAgentScopeRuntimeWebUISession>) {
    this.sessionList = this.sessionList.filter(
      (item) => item.id !== session.id,
    );
    localStorage.setItem(this.lsKey, JSON.stringify(this.sessionList));
    return [...this.sessionList];
  }
}

export default new SessionApi();
