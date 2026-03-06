import { Client, GatewayIntentBits } from 'discord.js'; // DISCORD CLIENT LIBRARY + BOT PERMISSIONS
import fetch from 'node-fetch'; // HTTP REQUESTS (tells Wix when event has changed/been added (URL to Wix is in .env))
import 'dotenv/config';
import path from 'path'; // Needed to find the .json file in service-account.json
import { fileURLToPath } from 'url';
import { google } from 'googleapis'; // BOT CAN TALK TO THE GOOGLE CALENDAR WITH THIS API
import express from 'express';

// EXPRESS SERVER FOR RENDER HOSTING
const app = express();
const PORT = process.env.PORT || 3000;

let botReady = false;

app.get('/', (req, res) => {
	res.send(botReady ? 'Bot is running!' : 'Discord bot not ready yet');
});

app.get('/poll', async (req, res) => {
	if (!client.isReady()) {
		return res.send('Discord bot not ready yet');
	}

	try {
		await pollEvents();
		res.send('Polled events!');
	} catch (err) {
		console.error('Error polling events via /poll:', err);
		res.status(500).send('Error polling events');
	}
});

app.listen(PORT, () => {
	console.log(`Express server running on port ${PORT}`);
});

// ------------------------------------- ENV CONFIG SECTION ----------------------------------------------------------
const DISCORD_SERVER = '509320358642319370'; // DISCORD SERVER ID - TGJ
const BOT_TOKEN = process.env.BOT_TOKEN; // BOTS PASSWORD TO DISCORD (so it can read server events)
const CALENDAR_ID = process.env.CALENDAR_ID;
const WEBHOOK_URL = process.env.WEBHOOK_URL || null; // HTTP REQUEST SENT TO WIX

// ------------------------------------- GOOGLE AUTH SECTION (GLOBAL) ------------------------------------------------
const filename = fileURLToPath(import.meta.url); // FINDS THE PATH TO THE .JSON FILE
const dirname = path.dirname(filename);

const auth = new google.auth.GoogleAuth({
	keyFile: path.join(dirname, 'service-account.json'),
	scopes: ['https://www.googleapis.com/auth/calendar'],
});

const calendar = google.calendar({
	// CREATE GOOGLE CLIENT - USED FOR AUTH, AFTER EVERY API CALL
	version: 'v3',
	auth,
});

// ------------------------------------- DISCORD CLIENT SECTION -----------------------------------------------------
const client = new Client({
	// MAKE BOT CLIENT
	intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildScheduledEvents], // BOT CLIENT CAN SEE --> SERVER INFO & EVENTS
});

// ------------------------------------- CREATE CACALENDAR SECTION ------------------------------------------------------
async function createCalendarEvent(event, discordEventId) {
	// AUTHENTICATES WITH GOOGLE (USING THE SERVICE / CLOUD ACCOUNT)

	try {
		const result = await calendar.events.insert({
			// USES GOOGLE CALENDARE API TO MAKE NEW EVENT
			calendarId: CALENDAR_ID, // THE CALENDAR WE USE
			eventId: `discord-${discordEventId}`,
			requestBody: {
				summary: event.name,
				description: event.description,
				start: { dateTime: event.start },
				end: { dateTime: event.end },
				extendedProperties: {
					private: { discordEventId },
				},
				colorId: '11',
			},
		});
		console.log(`Added new event to calendar: ${event.name}`);
		return { created: true, response: result };
	} catch (err) {
		if (err.code === 409) {
			// eventId finnes allerede
			console.log(
				`Event already exists in calendar, skipping: ${event.name}`,
			);
			return { created: false };
		}
		throw err;
	}
}
function normalizeDate(value) {
	// MAKES TIME STAMPS FROM GOOGLE & DISCORD IN SIMILAR FORMAT SO IT CAN COMPARE LATER AND UPDATE CORRECTLY (after updated event in Discord)
	if (!value) return null;
	return new Date(value).toISOString();
}

function normalizeText(value) {
	return (value || '').trim();
}

async function pollEvents() {
	console.log('pollEvents STARTED');

	if (!client.isReady()) {
		console.log('Bot is not ready yet, exiting pollEvents.');
		return;
	}

	try {
		// Hent Discord server
		const guild = await client.guilds.fetch(DISCORD_SERVER);
		console.log(`Fetched guild: ${guild.name}`);

		// Hent Discord events
		const discordEvents = await guild.scheduledEvents.fetch();
		console.log('discordEvents raw:', discordEvents);
		console.log(`Fetched ${discordEvents.size} Discord events`);

		const discordEventIds = new Set(discordEvents.map((e) => e.id));
		console.log('Discord event IDs:', [...discordEventIds]);
		console.log(
			'Discord event names:',
			[...discordEvents.values()].map((e) => e.name),
		);
		console.log(
			'Discord event start/end times:',
			[...discordEvents.values()].map((e) => ({
				id: e.id,
				name: e.name,
				start: e.scheduledStartAt,
				end: e.scheduledEndAt,
			})),
		);

		// Hent Google Calendar events
		const googleCalendarResponse = await calendar.events.list({
			calendarId: CALENDAR_ID,
			maxResults: 100,
		});

		const googleCalendarEvents = (
			googleCalendarResponse.data.items || []
		).filter((e) => e.extendedProperties?.private?.discordEventId);

		console.log(
			`Found ${googleCalendarEvents.length} Discord-linked events in Google Calendar:`,
			googleCalendarEvents.map((e) => e.summary),
		);

		// Map over Google Calendar events
		const googleCalendarEventMap = new Map();
		googleCalendarEvents.forEach((event) => {
			const discordId = event.extendedProperties?.private?.discordEventId;
			if (discordId) googleCalendarEventMap.set(discordId, event);
		});

		// Slett events som ikke finnes i Discord
		for (const [
			discordId,
			calendarEvent,
		] of googleCalendarEventMap.entries()) {
			if (!discordEventIds.has(discordId)) {
				console.log(
					`Will delete: ${calendarEvent.summary} (not in Discord anymore)`,
				);
				await calendar.events.delete({
					calendarId: CALENDAR_ID,
					eventId: calendarEvent.id,
				});
				console.log(`Deleted: ${calendarEvent.summary}`);
			} else {
				console.log(
					`Keeps: ${calendarEvent.summary} (still exists on Discord)`,
				);
			}
		}

		// Loop gjennom Discord events
		for (const [, discordEvent] of discordEvents) {
			const existingCalendarEvent = googleCalendarEventMap.get(
				discordEvent.id,
			);

			if (existingCalendarEvent) {
				// Sjekk om noe har endret seg
				const needsUpdate =
					normalizeText(existingCalendarEvent.summary) !==
						normalizeText(discordEvent.name) ||
					normalizeText(existingCalendarEvent.description) !==
						normalizeText(discordEvent.description) ||
					normalizeDate(existingCalendarEvent.start?.dateTime) !==
						normalizeDate(discordEvent.scheduledStartAt) ||
					normalizeDate(existingCalendarEvent.end?.dateTime) !==
						normalizeDate(discordEvent.scheduledEndAt);

				if (needsUpdate) {
					console.log(`Updating event: ${discordEvent.name}`);

					await calendar.events.update({
						calendarId: CALENDAR_ID,
						eventId: existingCalendarEvent.id,
						requestBody: {
							summary: discordEvent.name,
							description: discordEvent.description || '',
							start: { dateTime: discordEvent.scheduledStartAt },
							end: { dateTime: discordEvent.scheduledEndAt },
							extendedProperties: {
								private: { discordEventId: discordEvent.id },
							},
						},
					});

					// Webhook update
					if (WEBHOOK_URL) {
						const payload = {
							name: discordEvent.name,
							description: discordEvent.description || '',
							start: discordEvent.scheduledStartAt,
							end: discordEvent.scheduledEndAt,
							updated: true,
						};

						console.log('Sending webhook update to Wix:', payload);

						try {
							const res = await fetch(WEBHOOK_URL, {
								method: 'POST',
								headers: { 'Content-Type': 'application/json' },
								body: JSON.stringify(payload),
							});
							const text = await res.text();
							console.log(
								'Webhook response status:',
								res.status,
								'body:',
								text,
							);
						} catch (err) {
							console.error('Error sending webhook to Wix:', err);
						}
					}
				} else {
					console.log(`No changes for: ${discordEvent.name}`);
				}
			} else {
				// Opprett nytt event
				const result = await createCalendarEvent(
					{
						name: discordEvent.name,
						description: discordEvent.description || '',
						start: discordEvent.scheduledStartAt,
						end: discordEvent.scheduledEndAt,
					},
					discordEvent.id,
				);

				if (result.created && WEBHOOK_URL) {
					const payload = {
						name: discordEvent.name,
						description: discordEvent.description || '',
						start: discordEvent.scheduledStartAt,
						end: discordEvent.scheduledEndAt,
					};

					console.log('Sending new event webhook to Wix:', payload);

					try {
						const res = await fetch(WEBHOOK_URL, {
							method: 'POST',
							headers: { 'Content-Type': 'application/json' },
							body: JSON.stringify(payload),
						});
						const text = await res.text();
						console.log(
							'Webhook response status:',
							res.status,
							'body:',
							text,
						);
					} catch (err) {
						console.error(
							'Error sending new event webhook to Wix:',
							err,
						);
					}
				}
			}
		}
	} catch (err) {
		console.error('Error inside pollEvents:', err);
	}
}

// ------------------------------------- BOT-READY-TO-CHECK-EVENTS SECTION -------------------------------------------
client.on('ready', async () => {
	console.log(`Logged in as ${client.user.tag}`); // CLIENT.USER.TAG = THE BOT'S NAME

	try {
		const guild = await client.guilds.fetch(DISCORD_SERVER); // Hent server
		await guild.scheduledEvents.fetch(); // Sørg for at alle events er lastet
	} catch (err) {
		console.error('Error fetching guild or events before first poll:', err);
	}

	await pollEvents(); // FETCHES ALL EVENTS
	botReady = true;
	setInterval(pollEvents, 60 * 60 * 1000); // REPEATS EVERY 60 MIN (AKA UPDATES CALENDAR EVERY 60 MIN)
});

client.login(BOT_TOKEN); // LOGS BOT INTO DISCORD WITH THE BOT_TOKEN
