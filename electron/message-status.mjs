/** Match only provider identifiers. Equal text is never evidence of delivery. */
export function findAcceptedMessage(thread, clientUserMessageId) {
  for (const turn of thread?.turns || []) {
    const item = (turn.items || []).find(item => item.type === 'userMessage'
      && [item.clientId, item.clientUserMessageId, item.id].includes(clientUserMessageId));
    if (item) return { accepted: true, turnId: turn.id, status: turn.status, item };
  }
  return null;
}

export function uncertainDelivery(error) {
  return /timed?\s*out|timeout|не ответил|stream.*closed|exited|not running|соединени|подключени|поток.*закрыт|cli.*завершился/i.test(String(error?.message || error));
}
