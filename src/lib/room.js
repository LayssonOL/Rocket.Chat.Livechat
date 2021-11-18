import { route } from 'preact-router';

import { Livechat } from '../api';
import { CallStatus, isCallOngoing } from '../components/Calls/CallStatus';
import { setCookies, upsert, canRenderMessage, createToken } from '../components/helpers';
import I18n from '../i18n';
import { store } from '../store';
import { normalizeAgent } from './api';
import Commands from './commands';
import constants from './constants';
import { loadConfig, processUnread } from './main';
import { parentCall } from './parentCall';
import { normalizeMessage, normalizeMessages } from './threads';
import { handleTranscript } from './transcript';


const commands = new Commands();

export const closeChat = async ({ transcriptRequested } = {}) => {
	if (!transcriptRequested) {
		await handleTranscript();
	}

	await loadConfig();
	parentCall('callback', 'chat-ended');
	route('/chat-finished');
};

// TODO: use a separate event to listen to call start event. Listening on the message type isn't a good solution
export const processIncomingCallMessage = async (message) => {
	const { alerts } = store.state;
	try {
		await store.setState({
			incomingCallAlert: {
				show: true,
				callProvider: message.t,
				callerUsername: message.u.username,
				rid: message.rid,
				time: message.ts,
				callId: message._id,
				url: message.t === constants.jitsiCallStartedMessageType ? message.customFields.jitsiCallUrl : '',
			},
			ongoingCall: {
				callStatus: CallStatus.RINGING,
				time: message.ts,
			},
		});
	} catch (err) {
		console.error(err);
		const alert = { id: createToken(), children: I18n.t('error_getting_call_alert'), error: true, timeout: 5000 };
		await store.setState({ alerts: (alerts.push(alert), alerts) });
	}
};

const processMessage = async (message) => {
	if (message.t === 'livechat-close') {
		closeChat(message);
	} else if (message.t === 'command') {
		commands[message.msg] && commands[message.msg]();
	} else if (message.endTs) {
		await store.setState({ ongoingCall: { callStatus: CallStatus.ENDED, time: message.ts }, incomingCallAlert: null });
	} else if (message.t === constants.webRTCCallStartedMessageType || message.t === constants.jitsiCallStartedMessageType) {
		await processIncomingCallMessage(message);
	}
};

const doPlaySound = async (message) => {
	const { sound, user } = store.state;

	if (!sound.enabled || (user && message.u && message.u._id === user._id)) {
		return;
	}

	await store.setState({ sound: { ...sound, play: true } });
};

export const initRoom = async () => {
	const { state } = store;
	const { room } = state;

	if (!room) {
		return;
	}

	Livechat.unsubscribeAll();

	const { token, agent, queueInfo, room: { _id: rid, servedBy } } = state;
	Livechat.subscribeRoom(rid);

	let roomAgent = agent;
	if (!roomAgent) {
		if (servedBy) {
			roomAgent = await Livechat.agent({ rid });
			await store.setState({ agent: roomAgent, queueInfo: null });
			parentCall('callback', ['assign-agent', normalizeAgent(roomAgent)]);
		}
	}

	if (queueInfo) {
		parentCall('callback', ['queue-position-change', queueInfo]);
	}

	Livechat.onAgentChange(rid, async (agent) => {
		await store.setState({ agent, queueInfo: null });
		parentCall('callback', ['assign-agent', normalizeAgent(agent)]);
	});

	Livechat.onAgentStatusChange(rid, (status) => {
		const { agent } = store.state;
		agent && store.setState({ agent: { ...agent, status } });
		parentCall('callback', ['agent-status-change', normalizeAgent(agent)]);
	});

	Livechat.onQueuePositionChange(rid, async (queueInfo) => {
		await store.setState({ queueInfo });
		parentCall('callback', ['queue-position-change', queueInfo]);
	});

	setCookies(rid, token);
};

const isAgentHidden = () => {
	const { config: { settings: { agentHiddenInfo } = {} } = {} } = store.state;

	return !!agentHiddenInfo;
};

const transformAgentInformationOnMessage = (message) => {
	const { user } = store.state;
	if (message.u && message.u._id !== user._id && isAgentHidden()) {
		return { ...message, u: { _id: message.u._id } };
	}

	return message;
};

Livechat.onTyping((username, isTyping) => {
	const { typing, user, agent } = store.state;

	if (user && user.username && user.username === username) {
		return;
	}

	if (agent && agent.hiddenInfo) {
		return;
	}

	if (typing.indexOf(username) === -1 && isTyping) {
		typing.push(username);
		return store.setState({ typing });
	}

	if (!isTyping) {
		return store.setState({ typing: typing.filter((u) => u !== username) });
	}
});

Livechat.onMessage(async (message) => {
	if (message.ts instanceof Date) {
		message.ts = message.ts.toISOString();
	}

	message = await normalizeMessage(message);
	if (!message) {
		return;
	}

	message = transformAgentInformationOnMessage(message);

	await store.setState({
		messages: upsert(store.state.messages, message, ({ _id }) => _id === message._id, ({ ts }) => ts),
	});

	await processMessage(message);

	if (canRenderMessage(message) !== true) {
		return;
	}

	if (message.editedAt) {
		return;
	}

	await processUnread();
	await doPlaySound(message);
});

export const getGreetingMessages = (messages) => messages && messages.filter((msg) => msg.trigger);
export const getLatestCallMessage = (messages) => messages && messages.filter((msg) => msg.t === constants.webRTCCallStartedMessageType || msg.t === constants.jitsiCallStartedMessageType).pop();

export const loadMessages = async () => {
	const { ongoingCall } = store.state;

	const { messages: storedMessages, room: { _id: rid, callStatus } = {} } = store.state;
	const previousMessages = getGreetingMessages(storedMessages);
	if (!rid) {
		return;
	}

	await store.setState({ loading: true });
	const rawMessages = (await Livechat.loadMessages(rid)).concat(previousMessages);
	const messages = (await normalizeMessages(rawMessages)).map(transformAgentInformationOnMessage);

	await initRoom();
	await store.setState({ messages: (messages || []).reverse(), noMoreMessages: false, loading: false });

	if (messages && messages.length) {
		const lastMessage = messages[messages.length - 1];
		await store.setState({ lastReadMessageId: lastMessage && lastMessage._id });
	}

	if (ongoingCall && isCallOngoing(ongoingCall.callStatus)) {
		return;
	}

	const latestCallMessage = getLatestCallMessage(messages);
	if (!latestCallMessage) {
		return;
	}
	if (latestCallMessage.t === constants.jitsiCallStartedMessageType) {
		await store.setState({
			ongoingCall: {
				callStatus: CallStatus.IN_PROGRESS_DIFFERENT_TAB,
				time: latestCallMessage.ts,
			},
			incomingCallAlert: {
				show: false,
				callProvider:
				latestCallMessage.t,
				url: latestCallMessage.customFields.jitsiCallUrl,
			},
		});
		return;
	}
	switch (callStatus) {
		case CallStatus.IN_PROGRESS: {
			await store.setState({
				ongoingCall: {
					callStatus: CallStatus.IN_PROGRESS_DIFFERENT_TAB,
					time: latestCallMessage.ts,
				},
				incomingCallAlert: {
					show: false,
					callProvider: latestCallMessage.t,
				},
			});
			break;
		}
		case CallStatus.RINGING: {
			processIncomingCallMessage(latestCallMessage);
		}
	}
};

export const loadMoreMessages = async () => {
	const { room: { _id: rid } = {}, messages = [], noMoreMessages = false } = store.state;

	if (!rid || noMoreMessages) {
		return;
	}

	await store.setState({ loading: true });

	const rawMessages = await Livechat.loadMessages(rid, { limit: messages.length + 10 });
	const moreMessages = (await normalizeMessages(rawMessages)).map(transformAgentInformationOnMessage);

	await store.setState({
		messages: (moreMessages || []).reverse(),
		noMoreMessages: messages.length + 10 > moreMessages.length,
		loading: false,
	});
};

export const defaultRoomParams = () => {
	const params = {};

	const { defaultAgent: agent = {} } = store.state;
	if (agent && agent._id) {
		Object.assign(params, { agentId: agent._id });
	}

	return params;
};

store.on('change', ([state, prevState]) => {
	// Cross-tab communication
	// Detects when a room is created and then route to the correct container
	if (!prevState.room && state.room) {
		route('/');
	}
});
