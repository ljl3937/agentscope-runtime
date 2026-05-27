import { AgentScopeRuntimeWebUI, IAgentScopeRuntimeWebUIOptions } from '@agentscope-ai/chat';
import OptionsPanel from './OptionsPanel';
import { useMemo, useRef, useEffect } from 'react';
import sessionApi, { setSessionCreatedCallback } from './sessionApi';
import { useLocalStorageState } from 'ahooks';
import defaultConfig from './OptionsPanel/defaultConfig';
import Weather from '../Cards/Weather';

// 将 AgentScope 2.0 的 SSE 流转换为 @agentscope-ai/chat 包期望的格式
function transformAgentScope2SSE(
  originalResponse: Response,
): Response {
  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();

  // 读取原始响应并转换
  (async () => {
    try {
      const reader = originalResponse.body!.getReader();
      let buffer = '';
      const blockToMsgId = new Map<string, string>();  // block_id -> msg_id 映射
      const msgContentMap = new Map<string, string>();  // msg_id -> 累积的文本内容
      const msgTypeMap = new Map<string, string>();  // msg_id -> 消息类型 (reasoning/message)
      let responseId: string | null = null;  // 跟踪 REPLY_START 的 ID
      const messageIds: string[] = [];  // 跟踪所有已生成的消息 ID

      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || ''; // 保留未完成的行

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;

          try {
            const event = JSON.parse(line.slice(6));
            const eventType = event.type;

            // 处理不同类型的事件
            if (eventType === 'REPLY_START') {
              // 记录 response ID，后续 REPLY_END 的 ID 可能不同
              responseId = event.id;
              
              // 发送 response 对象
              const response = {
                object: 'response',
                id: event.id,
                status: 'in_progress',
                created_at: new Date(event.created_at).getTime(),  // 毫秒级时间戳
                output: [],
              };
              await writer.write(encoder.encode(`event: delta\ndata: ${JSON.stringify(response)}\n\n`));
            } else if (eventType === 'TEXT_BLOCK_START' || eventType === 'THINKING_BLOCK_START') {
              // 发送 message 对象，并记录 block_id -> msg_id 映射
              const msgId = event.id;
              const blockId = event.block_id;
              blockToMsgId.set(blockId, msgId);
              
              // 记录消息类型，用于后续构建 output
              const msgType = eventType === 'THINKING_BLOCK_START' ? 'reasoning' : 'message';
              msgTypeMap.set(msgId, msgType);
              
              // 记录消息 ID，用于后续构建 output
              messageIds.push(msgId);
              
              const message = {
                object: 'message',
                id: msgId,
                role: 'assistant',
                type: eventType === 'THINKING_BLOCK_START' ? 'reasoning' : 'message',
                content: [],
                status: 'in_progress',
              };
              await writer.write(encoder.encode(`event: delta\ndata: ${JSON.stringify(message)}\n\n`));
            } else if (eventType === 'TEXT_BLOCK_DELTA' || eventType === 'THINKING_BLOCK_DELTA') {
              // 发送 content 对象 (delta 流式内容)，使用 block_id 查找 msg_id
              const blockId = event.block_id;
              const msgId = blockToMsgId.get(blockId) || '';
              
              // 累积内容到 msgContentMap
              const accumulatedText = msgContentMap.get(msgId) || '';
              const newText = accumulatedText + (event.delta || '');
              msgContentMap.set(msgId, newText);
              
              // 注意：无论是 TEXT 还是 THINKING，content 的 type 都应该是 "text"
              // 因为 reasoning 消息通过 message.type="reasoning" 区分，其 content 仍然是 text 类型
              // @agentscope-ai/chat 的 handleContent 只识别 text/image/data 等 content type
              const content = {
                object: 'content',
                msg_id: msgId,
                type: 'text',  // 始终是 text，因为这是 content 的类型
                delta: true,
                text: event.delta || '',
                status: 'in_progress',
              };
              await writer.write(encoder.encode(`event: delta\ndata: ${JSON.stringify(content)}\n\n`));
            } else if (eventType === 'TEXT_BLOCK_END' || eventType === 'THINKING_BLOCK_END') {
              // block 结束，使用 block_id 查找对应的 msg_id
              const blockId = event.block_id;
              const msgId = blockToMsgId.get(blockId) || '';
              
              // 获取累积的完整内容
              const fullContent = msgContentMap.get(msgId) || '';
              
              // 发送 message completed 事件，包含完整的 content 数组
              // 这是为了通过 useChatRequest.tsx 的守卫条件：
              // if (res.status !== Failed && !res.output?.[0]?.content?.length) continue;
              const message = {
                object: 'message',
                id: msgId,
                role: 'assistant',
                type: eventType === 'THINKING_BLOCK_END' ? 'reasoning' : 'message',
                content: [
                  {
                    type: 'text',
                    text: fullContent,
                    status: 'completed',
                  }
                ],
                status: 'completed',
              };
              await writer.write(encoder.encode(`event: delta\ndata: ${JSON.stringify(message)}\n\n`));
              
              // 清理映射
              blockToMsgId.delete(blockId);
              // 注意：不要删除 msgContentMap，REPLY_END 还需要用它来构建 output
            } else if (eventType === 'REPLY_END') {
              // 使用 REPLY_START 的 ID（而不是 REPLY_END 的 ID），确保 UI 能正确识别响应完成
              const completedResponseId = responseId || event.id;
              
              // 构建 output 数组，包含所有已生成的消息及其完整内容
              // 这是为了让 useChatRequest.tsx 的守卫条件通过：
              // if (res.status !== Failed && !res.output?.[0]?.content?.length) continue;
              // 注意：handleResponse 会用这个 output 完全替换已有的 output
              // 所以我们必须确保这里的 output 包含完整正确的内容（包括 type, role 等字段）
              const output = messageIds.map(msgId => {
                const contentText = msgContentMap.get(msgId) || '';
                const msgType = msgTypeMap.get(msgId) || 'message';
                return {
                  id: msgId,
                  role: 'assistant',
                  type: msgType,
                  content: contentText ? [
                    {
                      type: 'text',
                      text: contentText,
                      status: 'completed',
                    }
                  ] : [],
                  status: 'completed',
                };
              });
              
              // 发送完成的 response，包含完整的 output
              // 虽然 handleResponse 会覆盖已有的 output，但我们发送的 output 是正确的
              const response = {
                object: 'response',
                id: completedResponseId,
                status: 'completed',
                created_at: new Date(event.created_at).getTime(),  // 毫秒级时间戳
                output: output,
              };
              await writer.write(encoder.encode(`event: delta\ndata: ${JSON.stringify(response)}\n\n`));
            }
            // 忽略其他事件类型（MODEL_CALL_START, TOOL_CALL_*, MODEL_CALL_END 等）
          } catch (e) {
            console.warn('[SSE Transformer] Failed to parse SSE event:', line, e);
          }
        }
      }
    } catch (e) {
      console.error('[SSE Transformer] Stream reading error:', e);
    } finally {
      await writer.close();
    }
  })();

  // 返回一个新的 Response，带有转换后的流
  return new Response(readable, {
    status: originalResponse.status,
    statusText: originalResponse.statusText,
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    },
  });
}

export default function () {
  const [optionsConfig, setOptionsConfig] = useLocalStorageState('agentscope2-webui-options', {
    defaultValue: defaultConfig,
    listenStorageChange: true,
  });

  const currentSessionIdRef = useRef<string | null>(null);
  const currentAgentIdRef = useRef<string | null>(null);
  const abortControllerRef = useRef<AbortController | null>(null);

  // 注册 session 创建回调
  useEffect(() => {
    setSessionCreatedCallback((sessionId: string) => {
      currentSessionIdRef.current = sessionId;
    });
  }, []);

  const options = useMemo(() => {
    const rightHeader = <OptionsPanel value={optionsConfig} onChange={(v: typeof optionsConfig) => {
      setOptionsConfig(prev => ({
        ...prev,
        ...v,
      }));
    }} />;

    // 自定义 fetch 函数 - 调用 AgentScope 2.0 的 /chat 端点
    const customFetch = async (data: {
      input: any[];
      biz_params?: any;
      signal?: AbortSignal;
    }): Promise<Response> => {
      const baseURL = optionsConfig.api?.baseURL || 'http://localhost:8000';
      let sessionId = currentSessionIdRef.current;

      // 如果没有 session,自动创建一个
      if (!sessionId) {
        sessionId = Date.now().toString();
        currentSessionIdRef.current = sessionId;
      }

      // 获取或创建 Agent (这也会创建 Credential)
      let agentId = currentAgentIdRef.current;
      if (!agentId) {
        agentId = await sessionApi.getOrCreateAgent(baseURL);
        currentAgentIdRef.current = agentId;
      }

      // 在 AgentScope 2.0 后端创建 session (需要带 chat_model_config)
      let backendSessionId: string;
      try {
        backendSessionId = await sessionApi.createSessionInBackend(baseURL, sessionId);
      } catch (e) {
        console.error('[AgentScope2] Failed to create session in backend:', e);
        throw new Error('Failed to create session. Please check your API configuration.');
      }

      // 将 Web UI 的输入格式转换为 AgentScope 2.0 的 Msg 格式
      // Web UI 传入的 input 是 [{ role, type: "message", content: [{ type: "text", text: "..." }] }] 格式
      // 需要转换为: { name, content: [{ type: "text", text: "..." }], role }
      const messages = data.input.map((item: any) => {
        // 提取文本内容
        let textContent = '';
        if (typeof item.content === 'string') {
          textContent = item.content;
        } else if (Array.isArray(item.content)) {
          // content 是数组,提取最后一个 text 类型(最新消息)
          const textBlocks = item.content.filter((c: any) => c.type === 'text');
          if (textBlocks.length > 0) {
            textContent = textBlocks[textBlocks.length - 1].text;
          }
        } else if (item.content && item.content.text) {
          textContent = item.content.text;
        }

        // 构造 AgentScope 2.0 的 Msg 格式
        return {
          name: item.name || 'user',
          role: item.role || 'user',
          content: [
            {
              type: 'text',
              text: textContent,
            },
          ],
        };
      });

      // 只取最后一条消息作为输入
      const lastMessage = messages[messages.length - 1];

      // 构造 AgentScope 2.0 的请求格式
      const requestBody = {
        agent_id: agentId,
        session_id: backendSessionId, // 使用后端返回的 session ID
        input: lastMessage,
      };

      // 调用 /chat 端点
      const response = await fetch(`${baseURL}/chat/`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-user-id': 'webui-user', // AgentScope 2.0 需要这个请求头
        },
        body: JSON.stringify(requestBody),
        signal: data.signal,
      });

      // 将 AgentScope 2.0 的 SSE 流转换为 OpenAI 兼容格式
      const transformedResponse = transformAgentScope2SSE(response);
      
      return transformedResponse;
    };

    // 自定义 cancel 函数
    const customCancel = (_data: { session_id: string }) => {
      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
        abortControllerRef.current = null;
      }
    };

    // 自定义 reconnect 函数
    const customReconnect = async (_data: {
      session_id: string;
      signal?: AbortSignal;
    }): Promise<Response> => {
      // AgentScope 2.0 不支持直接 reconnect session
      // 这里返回一个空响应
      return new Response(
        `data: {"id":"${Date.now()}","object":"response","status":"completed","created_at":${Date.now()},"output":[]}\n\n`,
        {
          headers: {
            'Content-Type': 'text/event-stream',
          },
        }
      );
    };


    return {
      ...optionsConfig,
      api: {
        baseURL: optionsConfig.api?.baseURL || 'http://localhost:8000',
        token: optionsConfig.api?.token || '',
        fetch: customFetch,
        cancel: customCancel,
        reconnect: customReconnect,
      },
      session: {
        multiple: true,
        api: sessionApi,
      },
      theme: {
        ...optionsConfig.theme,
        rightHeader,
      },
      customToolRenderConfig: {
        'weather search mock': Weather,
      },
    } as unknown as IAgentScopeRuntimeWebUIOptions
  }, [optionsConfig]);




  return <div style={{ height: '100vh' }}>
    <AgentScopeRuntimeWebUI
      options={options}
    />
  </div>;
}