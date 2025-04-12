// index.js
import Fastify from 'fastify';
import WebSocket from 'ws';
import twilio from 'twilio';
import dotenv from 'dotenv';
import fastifyFormBody from '@fastify/formbody';
import fastifyWs from '@fastify/websocket';
import { createClient } from '@supabase/supabase-js';

dotenv.config();

// Env vars
const {
  TWILIO_ACCOUNT_SID,
  TWILIO_AUTH_TOKEN,
  PHONE_NUMBER_FROM,
  DOMAIN: rawDomain,
  OPENAI_API_KEY,
  SUPABASE_URL,
  SUPABASE_SERVICE_ROLE_KEY
} = process.env;

const DOMAIN = rawDomain.replace(/(^\w+:|^)\/\//, '').replace(/\/+$/, '');
const PORT = process.env.PORT || 5050;
const VOICE = 'alloy';

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
const twilioClient = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);

// TwiML response without intros
const minimalTwiML = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <Stream url="wss://${DOMAIN}/media-stream" />
  </Connect>
</Response>`;

// Initialize Fastify
const fastify = Fastify();
fastify.register(fastifyFormBody);
fastify.register(fastifyWs);

// Twilio call webhook
fastify.all('/incoming-call', async (request, reply) => {
  reply.type('text/xml').send(minimalTwiML);
});

// Outbound call init
fastify.post('/make-call', async (request, reply) => {
  const { to } = request.body;
  try {
    const call = await twilioClient.calls.create({
      from: PHONE_NUMBER_FROM,
      to,
      twiml: minimalTwiML,
    });
    reply.send({ success: true, callSid: call.sid });
  } catch (error) {
    console.error('Outbound call error:', error);
    reply.status(500).send({ error: 'Call failed' });
  }
});

// WebSocket stream
fastify.register(async (fastify) => {
  fastify.get('/media-stream', { websocket: true }, (connection) => {
    let streamSid = null;
    let latestMediaTimestamp = 0;
    let responseStartTimestampTwilio = null;
    let markQueue = [];
    let lastAssistantItem = null;

    const openAiWs = new WebSocket('wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview-2024-10-01', {
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        "OpenAI-Beta": "realtime=v1"
      }
    });

    openAiWs.on('open', async () => {
      console.log('OpenAI connection started');
      const instructions = await fetchInstructionsFromSupabase(); // <-- fetch custom SYSTEM_MESSAGE here

      const sessionUpdate = {
        type: 'session.update',
        session: {
          turn_detection: { type: 'server_vad' },
          input_audio_format: 'g711_ulaw',
          output_audio_format: 'g711_ulaw',
          voice: VOICE,
          instructions: instructions || 'You are a helpful AI assistant.',
          modalities: ["text", "audio"],
          temperature: 0.8,
        }
      };

      openAiWs.send(JSON.stringify(sessionUpdate));
    });

    openAiWs.on('message', async (data) => {
      try {
        const response = JSON.parse(data);
        if (response.type === 'response.audio.delta' && response.delta) {
          const audioDelta = {
            event: 'media',
            streamSid,
            media: { payload: response.delta }
          };
          connection.send(JSON.stringify(audioDelta));

          if (!responseStartTimestampTwilio) {
            responseStartTimestampTwilio = latestMediaTimestamp;
          }

          if (response.item_id) lastAssistantItem = response.item_id;
          sendMark(connection, streamSid);
        }

        if (response.type === 'response.content.done') {
          await storeTranscriptionToSupabase(response);
          await postRealtimeUpdateToSupabase(response);
        }

      } catch (err) {
        console.error('OpenAI message error:', err);
      }
    });

    connection.on('message', (message) => {
      try {
        const data = JSON.parse(message);
        if (data.event === 'media') {
          latestMediaTimestamp = data.media.timestamp;
          if (openAiWs.readyState === WebSocket.OPEN) {
            openAiWs.send(JSON.stringify({
              type: 'input_audio_buffer.append',
              audio: data.media.payload
            }));
          }
        } else if (data.event === 'start') {
          streamSid = data.start.streamSid;
        }
      } catch (err) {
        console.error('Twilio message error:', err);
      }
    });

    connection.on('close', () => {
      openAiWs.close();
      console.log('Call closed.');
    });
  });
});

// Supabase helper stubs

async function fetchInstructionsFromSupabase() {
  // Example: look up AI behavior based on caller profile or route
  return 'You are a helpful assistant that answers legal questions simply.';
}

async function storeTranscriptionToSupabase(response) {
  // Save full transcript from OpenAI
  await supabase.from('call_transcripts').insert([
    { item_id: response.item_id, content: JSON.stringify(response) }
  ]);
}

async function postRealtimeUpdateToSupabase(response) {
  // Insert to a "call_updates" table; client dashboard listens via Supabase Realtime
  await supabase.from('call_updates').insert([
    { event_type: response.type, payload: JSON.stringify(response) }
  ]);
}

const start = async () => {
  try {
    await fastify.listen({ port: PORT });
    console.log(`Server running on port ${PORT}`);
  } catch (err) {
    console.error(err);
    process.exit(1);
  }
};

start();
