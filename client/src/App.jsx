import { useCallback, useEffect, useRef, useState } from 'react';
import { io } from 'socket.io-client';
import {
  createRoomKey,
  decryptImage,
  decryptMessage,
  encryptImage,
  encryptMessage,
  importRoomKey,
} from './crypto.js';

const SERVER_URL = import.meta.env.VITE_SERVER_URL || 'http://localhost:4000';
const MAX_IMAGE_BYTES = 9 * 1024 * 1024;

function Icon({ name }) {
  const paths = {
    lock: <><rect x="4" y="10" width="16" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/></>,
    plus: <><path d="M12 5v14M5 12h14"/></>,
    arrow: <><path d="M5 12h14M13 6l6 6-6 6"/></>,
    users: <><path d="M16 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="10" cy="7" r="4"/><path d="M20 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75"/></>,
    shield: <><path d="M12 22s8-4 8-11V5l-8-3-8 3v6c0 7 8 11 8 11Z"/><path d="m9 12 2 2 4-4"/></>,
    send: <><path d="m22 2-7 20-4-9-9-4Z"/><path d="M22 2 11 13"/></>,
    x: <><path d="m18 6-12 12M6 6l12 12"/></>,
    clock: <><circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/></>,
    copy: <><rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h3"/></>,
    image: <><rect x="3" y="3" width="18" height="18" rx="3"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="m21 15-5-5L5 21"/></>,
    eye: <><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/></>,
  };

  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className="icon"
      fill="none" stroke="currentColor" strokeWidth="1.7"
      strokeLinecap="round" strokeLinejoin="round">
      {paths[name]}
    </svg>
  );
}

function getUrlDetails() {
  const url = new URL(window.location.href);
  const roomId = url.searchParams.get('room');
  const fragment = new URLSearchParams(url.hash.slice(1));
  return { roomId, keyString: fragment.get('key') };
}

function getStableParticipantId() {
  const storageKey = 'hushroom-participant-id';

  try {
    let id = sessionStorage.getItem(storageKey);

    if (!id) {
      id = crypto.randomUUID();
      sessionStorage.setItem(storageKey, id);
    }

    return id;
  } catch {
    return crypto.randomUUID();
  }
}

export default function App() {
  const [view, setView] = useState('home');
  const [pin, setPin] = useState('');
  const [name, setName] = useState('');
  const [room, setRoom] = useState(null);
  const [roomKey, setRoomKey] = useState(null);
  const [inviteUrl, setInviteUrl] = useState('');
  const [messages, setMessages] = useState([]);
  const [draft, setDraft] = useState('');
  const [members, setMembers] = useState([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [uploadingImage, setUploadingImage] = useState(false);
  const [viewingImageIds, setViewingImageIds] = useState([]);
  const [copied, setCopied] = useState(false);
  const [attachmentOpen, setAttachmentOpen] = useState(false);

  const socketRef = useRef(null);
  const ownerTokenRef = useRef(null);
  const participantIdRef = useRef(null);
  const participantTokenRef = useRef(null);
  const bottomRef = useRef(null);
  const fileInputRef = useRef(null);
  const imageUrlsRef = useRef(new Set());

  const getParticipantId = () => {
    if (!participantIdRef.current) {
      participantIdRef.current = getStableParticipantId();
    }
    return participantIdRef.current;
  };

  const revokeImageUrls = useCallback(() => {
    for (const url of imageUrlsRef.current) {
      URL.revokeObjectURL(url);
    }
    imageUrlsRef.current.clear();
  }, []);

  useEffect(() => {
    const { roomId, keyString } = getUrlDetails();

    if (roomId) {
      setRoom((current) => current || { id: roomId, creator: false });
      setView('join');

      if (keyString) {
        importRoomKey(keyString)
          .then(setRoomKey)
          .catch((err) => setError(err.message));
      } else {
        setError('This invite link has no encryption key. Ask the creator to send the full invite link.');
      }
    }
  }, []);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [messages]);

  useEffect(() => {
    return () => {
      socketRef.current?.disconnect();
      revokeImageUrls();
    };
  }, [revokeImageUrls]);

  const leaveSocket = useCallback(() => {
    socketRef.current?.disconnect();
    socketRef.current = null;
    participantTokenRef.current = null;
  }, []);

  const wipeLocal = useCallback((reason = 'ended') => {
    leaveSocket();
    revokeImageUrls();
    setMessages([]);
    setMembers([]);
    setDraft('');
    setRoomKey(null);
    setRoom(null);
    setViewingImageIds([]);
    ownerTokenRef.current = null;
    participantTokenRef.current = null;
    setInviteUrl('');
    setPin('');
    setName('');
    setView('ended');
    setError(
      reason === 'expired'
        ? 'This conversation expired after 30 minutes without activity.'
        : 'This conversation has been destroyed.'
    );
    window.history.replaceState({}, document.title, window.location.pathname);
  }, [leaveSocket, revokeImageUrls]);

  const createRoom = async () => {
    setBusy(true);
    setError('');

    try {
      const response = await fetch(`${SERVER_URL}/api/rooms`, { method: 'POST' });
      const data = await response.json();

      if (!response.ok) throw new Error(data.error || 'Could not create a room.');

      const generated = await createRoomKey();
      const url = new URL(window.location.href);
      url.search = '';
      url.hash = '';
      url.searchParams.set('room', data.roomId);
      url.hash = new URLSearchParams({ key: generated.encoded }).toString();

      ownerTokenRef.current = data.ownerToken;
      setRoom({ id: data.roomId, creator: true });
      setPin(data.pin);
      setRoomKey(generated.key);
      setInviteUrl(url.toString());
      setView('invite');
    } catch (err) {
      setError(err.message || 'Could not create a room.');
    } finally {
      setBusy(false);
    }
  };

  const joinRoom = async () => {
    setBusy(true);
    setError('');

    try {
      if (!/^\d{5}$/.test(pin)) throw new Error('Enter the five-digit room PIN.');
      if (!name.trim()) throw new Error('Choose a temporary display name.');

      let key = roomKey;

      if (!key) {
        const { keyString } = getUrlDetails();
        key = await importRoomKey(keyString);
        setRoomKey(key);
      }

      const response = await fetch(`${SERVER_URL}/api/rooms/join`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pin }),
      });

      const data = await response.json();

      if (!response.ok) throw new Error(data.error || 'Could not join this room.');

      const { roomId: invitedRoomId } = getUrlDetails();

      if (invitedRoomId && invitedRoomId !== data.roomId) {
        throw new Error('That PIN does not match this invitation link.');
      }

      await connectToRoom(data.roomId, pin, name.trim(), key, false);
    } catch (err) {
      setError(err.message || 'Could not join this room.');
    } finally {
      setBusy(false);
    }
  };

  const connectToRoom = async (roomId, roomPin, displayName, key, creator) => {
    leaveSocket();

    const participantId = getParticipantId();
    const socket = io(SERVER_URL, {
      transports: ['websocket', 'polling'],
      auth: { clientVersion: 1 },
    });

    socketRef.current = socket;

    socket.on('connect_error', () => {
      setError('Connection failed. Check the server and try again.');
    });

    socket.on('room:destroyed', ({ reason }) => wipeLocal(reason));

    socket.on('participant:joined', (person) => {
      setMembers((current) =>
        current.some((member) => member.id === person.id)
          ? current
          : [...current, person]
      );
    });

    socket.on('participant:left', ({ id }) => {
      setMembers((current) => current.filter((member) => member.id !== id));
    });

    socket.on('message:new', async (packet) => {
      try {
        const plaintext = await decryptMessage(key, packet);
        let messageContent;

        try {
          messageContent = JSON.parse(plaintext);
        } catch {
          messageContent = null;
        }

        let newMessage;

        if (
          messageContent?.type === 'image' &&
          typeof messageContent.imageId === 'string' &&
          typeof messageContent.imageKey === 'string' &&
          typeof messageContent.imageIv === 'string'
        ) {
          newMessage = {
            ...packet,
            type: 'image',
            imageId: messageContent.imageId,
            imageKey: messageContent.imageKey,
            imageIv: messageContent.imageIv,
            mimeType: messageContent.mimeType || 'image/jpeg',
            text: '',
            imageUrl: null,
            imageUnavailable: false,
          };
        } else {
          newMessage = { ...packet, type: 'text', text: plaintext };
        }

        setMessages((current) =>
          current.some((message) => message.id === packet.id)
            ? current
            : [...current, newMessage]
        );
      } catch {
        setError('A message could not be decrypted. Confirm everyone has the same invitation link.');
      }
    });

    const joined = await new Promise((resolve, reject) => {
      socket.once('connect', () => {
        socket.emit(
          'room:join',
          {
            roomId,
            pin: roomPin,
            name: displayName,
            participantId,
          },
          (result) => {
            if (result?.ok) resolve(result);
            else reject(new Error(result?.error || 'Could not join this room.'));
          }
        );
      });

      socket.once('connect_error', () => {
        reject(new Error('Could not connect to the chat server.'));
      });
    });

    if (!joined.participantToken) {
      socket.disconnect();
      throw new Error('The server did not issue image-sharing credentials. Check the backend version.');
    }

    participantTokenRef.current = joined.participantToken;
    setRoom({ id: roomId, creator });
    setRoomKey(key);
    setMembers(joined.members || []);
    setMessages([]);
    setViewingImageIds([]);
    setError('');
    setView('chat');
  };

  const sendMessage = async (event) => {
    event?.preventDefault();

    const text = draft.trim();

    if (!text || !socketRef.current || !roomKey) return;

    if (text.length > 2000) {
      setError('Messages must be 2,000 characters or fewer.');
      return;
    }

    setDraft('');

    try {
      const encrypted = await encryptMessage(roomKey, text);

      socketRef.current.emit('message:send', encrypted, (result) => {
        if (!result?.ok) setError(result?.error || 'Message could not be sent.');
      });
    } catch {
      setError('Could not encrypt this message.');
    }
  };

  const sendImage = async (event) => {
    event.preventDefault();

    const file = fileInputRef.current?.files?.[0];

    if (!file || !room || !roomKey || !socketRef.current) return;

    if (!file.type.startsWith('image/')) {
      setError('Choose an image file.');
      return;
    }

    if (file.size === 0 || file.size > MAX_IMAGE_BYTES) {
      setError('Choose an image smaller than 9 MB.');
      return;
    }

    if (!participantTokenRef.current) {
      setError('Your image-sharing session has expired. Leave and rejoin the room.');
      return;
    }

    setUploadingImage(true);
    setError('');

    try {
      // Encrypt the image locally. Only encrypted bytes are uploaded.
      const encryptedImage = await encryptImage(file);

      const uploadResponse = await fetch(
        `${SERVER_URL}/api/rooms/${encodeURIComponent(room.id)}/images`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/octet-stream',
            'X-Participant-Id': getParticipantId(),
            'X-Participant-Token': participantTokenRef.current,
          },
          body: encryptedImage.ciphertext,
        }
      );

      const uploadData = await uploadResponse.json().catch(() => ({}));

      if (!uploadResponse.ok) {
        throw new Error(uploadData.error || 'The encrypted image could not be uploaded.');
      }

      if (!uploadData.imageId) {
        throw new Error('The server did not return an image ID.');
      }

      // The image key is sent only inside the existing encrypted chat message.
      const imageMessage = {
        type: 'image',
        imageId: uploadData.imageId,
        imageKey: encryptedImage.key,
        imageIv: encryptedImage.iv,
        mimeType: file.type,
      };

      const encryptedMessage = await encryptMessage(roomKey, JSON.stringify(imageMessage));

      await new Promise((resolve, reject) => {
        socketRef.current.emit('message:send', encryptedMessage, (result) => {
          if (result?.ok) resolve();
          else reject(new Error(result?.error || 'The image message could not be sent.'));
        });
      });

      if (fileInputRef.current) fileInputRef.current.value = '';
    } catch (err) {
      setError(err.message || 'Could not share this image.');
    } finally {
      setUploadingImage(false);
    }
  };

  const revealImage = async (message) => {
    if (
      !room ||
      !message.imageId ||
      viewingImageIds.includes(message.imageId) ||
      message.imageUrl ||
      message.imageUnavailable
    ) {
      return;
    }

    if (!participantTokenRef.current) {
      setError('Your image-sharing session has expired. Leave and rejoin the room.');
      return;
    }

    setViewingImageIds((current) =>
      current.includes(message.imageId) ? current : [...current, message.imageId]
    );
    setError('');

    try {
      const response = await fetch(
        `${SERVER_URL}/api/rooms/${encodeURIComponent(room.id)}/images/${encodeURIComponent(message.imageId)}/view`,
        {
          method: 'POST',
          headers: {
            'X-Participant-Id': getParticipantId(),
            'X-Participant-Token': participantTokenRef.current,
          },
          cache: 'no-store',
        }
      );

      if (!response.ok) {
        if (response.status === 410 || response.status === 404) {
          setMessages((current) =>
            current.map((item) =>
              item.id === message.id
                ? { ...item, imageUnavailable: true }
                : item
            )
          );
          return;
        }

        if (response.status === 403) {
          throw new Error('You are not authorized to view this image.');
        }

        throw new Error('The image could not be retrieved. It may have expired.');
      }

      const encryptedBytes = await response.arrayBuffer();

      // The backend returns ciphertext. Decryption happens on this device.
      const plaintextBytes = await decryptImage(
        encryptedBytes,
        message.imageKey,
        message.imageIv
      );

      const blob = new Blob([plaintextBytes], {
        type: message.mimeType || 'image/jpeg',
      });

      const imageUrl = URL.createObjectURL(blob);
      imageUrlsRef.current.add(imageUrl);

      setMessages((current) =>
        current.map((item) =>
          item.id === message.id ? { ...item, imageUrl } : item
        )
      );
    } catch (err) {
      setError(err.message || 'Could not open this image.');
    } finally {
      setViewingImageIds((current) =>
        current.filter((id) => id !== message.imageId)
      );
    }
  };

  const copyInvite = async () => {
    try {
      await navigator.clipboard.writeText(inviteUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      setError('Clipboard access failed. Select and copy the invite link manually.');
    }
  };

  const endRoom = async () => {
    if (!room?.creator || !ownerTokenRef.current) return;

    const confirmed = window.confirm(
      'End this HushRoom for everyone? All participants will be disconnected.'
    );

    if (!confirmed) return;

    setBusy(true);

    try {
      const response = await fetch(`${SERVER_URL}/api/rooms/${room.id}/end`, {
        method: 'POST',
        headers: { 'x-owner-token': ownerTokenRef.current },
      });

      const data = await response.json();

      if (!response.ok) throw new Error(data.error || 'Could not end the room.');

      wipeLocal('ended');
    } catch (err) {
      setError(err.message || 'Could not end the room.');
    } finally {
      setBusy(false);
    }
  };

  const backHome = () => {
    wipeLocal('ended');
    setView('home');
    setError('');
  };

  if (view === 'chat') {
    const sorted = [...messages].sort((a, b) => a.sentAt - b.sentAt);

    return (
      <main className="app-shell chat-shell">
        <header className="chat-header">
          <button className="brand-button" onClick={backHome}>
            <span className="brand-mark"><Icon name="lock"/></span>
            <span>hushroom</span>
          </button>

          <div className="header-status"><span className="status-dot"/> Encrypted session</div>

          <div className="room-actions">
            <button className="leave-button" onClick={backHome} disabled={busy} type="button">
              Leave room
            </button>

            {room?.creator && (
              <button className="danger-button" onClick={endRoom} disabled={busy} type="button">
                <Icon name="x"/> {busy ? 'Ending…' : 'End room for everyone'}
              </button>
            )}
          </div>
        </header>

        <section className="chat-layout">
          <aside className="side-panel">
            <div className="panel-label">YOUR ROOM</div>
            <div className="room-code">{pin || '•••••'}</div>
            <p className="muted small">Share the PIN separately from the invite link.</p>

            <div className="divider"/>

            <div className="panel-label">
              <Icon name="users"/> PEOPLE HERE <span className="count-pill">{members.length}</span>
            </div>

            <div className="member-list">
              {members.map((member) => (
                <div className="member" key={member.id}>
                  <span className="avatar">{(member.name || '?').slice(0, 1).toUpperCase()}</span>
                  <span>{member.name}{member.id === socketRef.current?.id ? ' (you)' : ''}</span>
                </div>
              ))}
            </div>

            <div className="privacy-note">
              <Icon name="shield"/>
              <div>
                <strong>Private by design</strong>
                <p>Messages and images are encrypted in your browser before transmission.</p>
              </div>
            </div>
          </aside>

          <section className="conversation">
            <div className="conversation-top">
              <div>
                <div className="panel-label">LIVE CONVERSATION</div>
                <h1>Room is active</h1>
              </div>
              <div className="expiry"><Icon name="clock"/> 30 min inactivity expiry</div>
            </div>

            <div className="message-list">
              {sorted.length === 0 && (
                <div className="empty-chat">
                  <div className="empty-icon"><Icon name="lock"/></div>
                  <h2>This is your quiet space.</h2>
                  <p>Messages are encrypted before they leave your device. Start the conversation when you're ready.</p>
                </div>
              )}

              {sorted.map((message) => (
                <article
                  className={`message ${message.senderId === socketRef.current?.id ? 'mine' : ''} ${message.type === 'image' ? 'image-message' : ''}`}
                  key={message.id}
                >
                  <div className="message-meta">
                    <strong>{message.senderName}</strong>
                    <time>
                      {new Date(message.sentAt).toLocaleTimeString([], {
                        hour: '2-digit',
                        minute: '2-digit',
                      })}
                    </time>
                  </div>

                  {message.type !== 'image' ? (
                    <p>{message.text}</p>
                  ) : (
                    <div className="view-once-card">
                      {message.imageUrl ? (
                        <div className="revealed-image">
                          <img src={message.imageUrl} alt="View-once shared image"/>
                          <p className="image-viewed-note">
                            <Icon name="shield"/> Opened
                          </p>
                        </div>
                      ) : message.imageUnavailable ? (
                        <div className="view-once-status unavailable">
                          <span className="view-once-one">1</span>
                          <div className="view-once-copy">
                            <strong>Photo</strong>
                            <span>Unavailable · already opened or expired</span>
                          </div>
                        </div>
                      ) : (
                        <button
                          className="view-once-trigger"
                          type="button"
                          onClick={() => revealImage(message)}
                          disabled={viewingImageIds.includes(message.imageId)}
                          aria-label="Open view-once photo"
                        >
                          <span className="view-once-one">1</span>
                          <span className="view-once-copy">
                            <strong>Photo</strong>
                            <span>
                              {viewingImageIds.includes(message.imageId)
                                ? 'Opening…'
                                : 'View once'}
                            </span>
                          </span>
                          <span className="view-once-open">
                            <Icon name="eye"/>
                          </span>
                        </button>
                      )}
                    </div>
                  )}
                </article>
              ))}

              <div ref={bottomRef}/>
            </div>

            {error && (
              <div className="inline-error">
                {error}
                <button onClick={() => setError('')} aria-label="Dismiss">×</button>
              </div>
            )}

            <form className="composer" onSubmit={sendMessage}>
              <div className="attachment-wrap">
                <button
                  className="attachment-plus"
                  type="button"
                  onClick={() => setAttachmentOpen((open) => !open)}
                  disabled={uploadingImage || busy}
                  aria-label="Open attachments"
                  aria-expanded={attachmentOpen}
                  title="Attach"
                >
                  <Icon name="plus"/>
                </button>

                {attachmentOpen && (
                  <div className="attachment-menu">
                    <button
                      type="button"
                      className="attachment-menu-item"
                      onClick={() => {
                        setAttachmentOpen(false);
                        fileInputRef.current?.click();
                      }}
                      disabled={uploadingImage || busy}
                    >
                      <span className="attachment-menu-icon"><Icon name="image"/></span>
                      <span>
                        <strong>Photo / Image</strong>
                        <small>Send a view-once photo</small>
                      </span>
                    </button>
                  </div>
                )}
              </div>

              <input
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                maxLength={2000}
                placeholder="Write a message…"
                aria-label="Message"
                autoComplete="off"
              />

              <input
                ref={fileInputRef}
                type="file"
                accept="image/*"
                className="image-file-input"
                aria-label="Choose an image to share"
                onChange={sendImage}
              />

              <button
                className="send-button"
                type="submit"
                disabled={!draft.trim() || uploadingImage}
                aria-label="Send message"
              >
                <Icon name="send"/>
              </button>
            </form>

            <div className="composer-foot">
              <span><Icon name="shield"/> End-to-end encrypted</span>
              <span>Images are view-once</span>
            </div>
          </section>
        </section>
      </main>
    );
  }

  return (
    <main className="app-shell">
      <header className="site-header">
        <button className="brand-button" onClick={backHome}>
          <span className="brand-mark"><Icon name="lock"/></span>
          <span>hushroom</span>
        </button>
        <div className="header-note"><span className="status-dot"/> Temporary by design</div>
      </header>

      <section className="hero">
        <div className="eyebrow"><span className="eyebrow-line"/> A LITTLE SPACE, JUST FOR YOU</div>
        <h1>Some things are<br/><span>better said privately.</span></h1>
        <p className="hero-copy">Create a quiet room for a conversation. Invite the people you trust. When it's over, the room disappears.</p>

        <div className="hero-actions">
          <button className="primary-button" onClick={createRoom} disabled={busy}>
            <Icon name="plus"/>{busy ? 'Creating…' : 'Create a private room'}
          </button>
          <button className="secondary-button" onClick={() => { setView('join'); setError(''); }}>
            <Icon name="arrow"/> Join with a PIN
          </button>
        </div>

        {error && (
          <div className="inline-error standalone">
            {error}
            <button onClick={() => setError('')} aria-label="Dismiss">×</button>
          </div>
        )}

        {view === 'invite' && room && (
          <div className="invite-card">
            <div className="invite-top">
              <span className="success-mark"><Icon name="shield"/></span>
              <div>
                <strong>Your room is ready</strong>
                <p>Send the invite link and share this PIN separately.</p>
              </div>
            </div>

            <label className="field-label">FIVE-DIGIT PIN</label>
            <div className="pin-display">{pin}</div>

            <label className="field-label">SECRET INVITE LINK</label>
            <div className="invite-link-row">
              <input readOnly value={inviteUrl} onFocus={(event) => event.target.select()} aria-label="Secret invite link"/>
              <button className="copy-button" onClick={copyInvite}>
                <Icon name="copy"/>{copied ? 'Copied' : 'Copy link'}
              </button>
            </div>

            <button className="primary-button full-width" onClick={() => { setName(''); setView('join'); }}>
              Enter your room <Icon name="arrow"/>
            </button>

            <p className="fine-print">Anyone with the full link can access the room key. Share it only with trusted people.</p>
          </div>
        )}

        {view === 'join' && (
          <form className="join-card" onSubmit={(event) => { event.preventDefault(); joinRoom(); }}>
            <div className="join-title">
              <span className="join-icon"><Icon name="lock"/></span>
              <div>
                <strong>Join a conversation</strong>
                <p>Use the five-digit PIN you were given.</p>
              </div>
            </div>

            <label className="field-label" htmlFor="pin">ROOM PIN</label>
            <input
              id="pin"
              className="pin-input"
              inputMode="numeric"
              pattern="[0-9]{5}"
              maxLength={5}
              value={pin}
              onChange={(event) => setPin(event.target.value.replace(/\D/g, '').slice(0, 5))}
              placeholder="00000"
              autoComplete="off"
              required
            />

            <label className="field-label" htmlFor="displayName">TEMPORARY DISPLAY NAME</label>
            <input
              id="displayName"
              className="text-input"
              value={name}
              onChange={(event) => setName(event.target.value.slice(0, 24))}
              placeholder="e.g. Alex"
              maxLength={24}
              autoComplete="off"
              required
            />

            {error && (
              <div className="inline-error">
                {error}
                <button type="button" onClick={() => setError('')} aria-label="Dismiss">×</button>
              </div>
            )}

            <button className="primary-button full-width" type="submit" disabled={busy}>
              {busy ? 'Joining…' : 'Join room'} <Icon name="arrow"/>
            </button>

            <button className="text-button" type="button" onClick={() => { setView('home'); setError(''); }}>
              Back
            </button>
          </form>
        )}

        {view === 'ended' && (
          <div className="join-card ended-card">
            <span className="ended-icon"><Icon name="shield"/></span>
            <strong>Room closed</strong>
            <p>{error || 'This conversation has been destroyed.'}</p>
            <button className="primary-button full-width" onClick={() => { setView('home'); setError(''); }}>
              Return home
            </button>
          </div>
        )}

        <div className="trust-row">
          <div><Icon name="shield"/><span>End-to-end encryption</span></div>
          <div><Icon name="clock"/><span>30-minute inactivity expiry</span></div>
          <div><Icon name="users"/><span>No accounts needed</span></div>
        </div>
      </section>

      <footer className="site-footer">
        <span>hushroom</span>
        <span>Private conversations, without the baggage.</span>
        <a href="#privacy" onClick={(event) => {
          event.preventDefault();
          alert('HushRoom is a starter project. Review the README security notes before production use.');
        }}>Privacy notes</a>
      </footer>
    </main>
  );
}
