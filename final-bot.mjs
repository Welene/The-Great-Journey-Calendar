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
			console.log(
				`Event already exists in calendar, skipping adding this event to calendar: ${event.name}`,
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
	try {
		const guild = await client.guilds.fetch(DISCORD_SERVER); // FETCHES SERVER
		const discordEvents = await guild.scheduledEvents.fetch(); // FETCHES ALL EVENTS
		const discordEventIds = new Set(discordEvents.map((e) => e.id)); // MAPS OVER ALL EVENTS IN DISCORD RIGHT NOW

		console.log(
			`Got ${discordEvents.size} event(s) from this Discord server:`,
		);
		console.log([...discordEvents.values()].map((e) => e.name));

		// FETCH ALL EVENTS IN GOOGLE CALENDAR ...............(added by the bot (AKA every event with a discordEventId in extendedProperties up there ^))
		const googleCalendarResponse = await calendar.events.list({
			calendarId: CALENDAR_ID,
			maxResults: 100,
		});

		const googleCalendarEvents = (
			googleCalendarResponse.data.items || []
		).filter((e) => e.extendedProperties?.private?.discordEventId);

		console.log(
			`Found ${googleCalendarEvents.length} Discord-linked events in Google Calendar:`,
		);
		console.log(googleCalendarEvents.map((e) => e.summary));

		// MAPS ALL GOOGLE CALENDAR EVENTS
		const googleCalendarEventMap = new Map();
		googleCalendarEvents.forEach((event) => {
			const discordId = event.extendedProperties?.private?.discordEventId;
			if (discordId) googleCalendarEventMap.set(discordId, event);
		});

		// DELETES EVENTS FROM CALENDAR THAT DOES NOT EXIST IN DISCORD ANYMORE
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

		// -------------------------------------------- UPDATE CHANGED EVENTS SECTION -------------------------------------------------------

		for (const [, discordEvent] of discordEvents) {
			// LOOP THROUGH ALL EVENTS (event = has all meta data --> name, desc, start/end times)

			const existingCalendarEvent = googleCalendarEventMap.get(
				discordEvent.id,
			);

			if (existingCalendarEvent) {
				// ----------------- NY KODE: sjekker om noe har endret seg -----------------

				const needsUpdate = // CHANGES ALL TIMES TO THE SAME FORMAT WITH "normalizeText"
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

					// ----------------- NY KODE: send oppdatering til Wix -----------------
					if (WEBHOOK_URL) {
						await fetch(WEBHOOK_URL, {
							method: 'POST',
							headers: { 'Content-Type': 'application/json' },
							body: JSON.stringify({
								name: discordEvent.name,
								description: discordEvent.description || '',
								start: discordEvent.scheduledStartAt,
								end: discordEvent.scheduledEndAt,
								updated: true, // flagger at dette er en oppdatering
							}),
						});
					}
				} else {
					console.log(`No changes for: ${discordEvent.name}`);
				}

				continue; // skip legger til nytt event
			}

			// ----------------- EKSISTERENDE LOGIKK: legg til nytt event -----------------
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
				await fetch(WEBHOOK_URL, {
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({
						name: discordEvent.name,
						description: discordEvent.description || '',
						start: discordEvent.scheduledStartAt,
						end: discordEvent.scheduledEndAt,
					}),
				});
			}
		}
	} catch (err) {
		console.error('Cannot fetch any events on the server:', err);
	}
}

// ------------------------------------- BOT-READY-TO-CHECK-EVENTS SECTION -------------------------------------------
client.on('ready', async () => {
	console.log(`Logged in as ${client.user.tag}`); // CLIENT.USER.TAG = THE BOT'S NAME
	await pollEvents(); // FETCHES ALL EVENTS
	setInterval(pollEvents, 60 * 60 * 1000); // REPEATS EVERY 60 MIN (AKA UPDATES CALENDAR EVERY 60 MIN)
});

client.login(BOT_TOKEN); // LOGS BOT INTO DISCORD WITH THE BOT_TOKEN

app.listen(PORT, () => {
	console.log(`Express server running on port ${PORT}`);
});
