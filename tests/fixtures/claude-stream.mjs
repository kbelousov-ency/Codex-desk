// Real stdio fixture, never launches a model or executes proposed tools.
import { createInterface } from 'node:readline';
const send = frame => process.stdout.write(`${JSON.stringify(frame)}\n`);
let pending, sequence = 0;
function finish(user, text) {
  send({ type: 'assistant', uuid: `assistant-${sequence}`, message: { id: `message-${sequence}`, content: [{ type: 'text', text }] } });
  send({ type: 'result', subtype: 'success', is_error: false, user_message_uuid: user.uuid, usage: { input_tokens: 1, output_tokens: 1 } });
}
createInterface({ input: process.stdin }).on('line', line => {
  const frame = JSON.parse(line);
  if (frame.type === 'control_request') {
    const response = frame.request.subtype === 'initialize' ? { models: [{ value: 'fixture', displayName: 'Fixture' }], account: {}, current_permission_mode: 'default' }
      : frame.request.subtype === 'get_settings' ? { applied: { model: 'fixture', effort: 'medium' } } : {};
    send({ type: 'control_response', response: { subtype: 'success', request_id: frame.request_id, response } });
  } else if (frame.type === 'user') {
    sequence++;
    if (sequence === 1) {
      if (!frame.message.content.some(b => b.type === 'image' && b.source.media_type === 'image/png')) throw new Error('image missing');
      pending = frame;
      send({ type: 'control_request', request_id: 'tool-permission', request: { subtype: 'can_use_tool', tool_name: 'Bash', tool_use_id: 'test-command', input: { command: 'fixture-only' } } });
    } else finish(frame, 'Следующий запрос получен');
  } else if (frame.type === 'control_response' && frame.response.request_id === 'tool-permission') {
    if (frame.response.response.behavior !== 'allow') throw new Error('approval missing');
    send({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'test-command', content: 'Разрешено' }] } });
    finish(pending, 'Изображение получено'); pending = undefined;
  }
});
