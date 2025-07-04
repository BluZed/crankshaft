import { readFileSync, readdirSync, writeFileSync, existsSync } from 'fs';
import { resolve as pathResolve } from 'path';
import { ipcRenderer } from 'electron';
import { strippedConsole } from './preload';
import { userscriptToggleCSS } from './utils';
import { customSettingSavedJSONIsNotMalformed } from './userscriptvalidators';

/** sharedUserscriptData */
export const su = {
	userscriptsPath: '',
	userscriptTrackerPath: '',
	userscriptPrefsPath: '',
	userscripts: <IUserscriptInstance[]>[],
	userscriptTracker: <UserscriptTracker>{}
};

/** simple error message for usercripts. can be called from the userscript itself */
const errAlert = (err: Error, name: string) => {
	// eslint-disable-next-line no-alert
	alert(`Userscript '${name}' had an error:\n\n${err.toString()}\n\nPlease fix the error, disable the userscript in the 'tracker.json' file or delete it.\nFeel free to check console for stack trace`);
};

/*
 * Adapted from https://github.com/pd4d10/userscript-meta
 * MIT License, (c) 2016 pd4d10 https://github.com/pd4d10/userscript-meta/blob/master/LICENSE
 */
const parseMetadata = (meta: string) => meta.split(/[\r\n]/u)
	.filter(line => /\S+/u.test(line) // remove blank line
				&& line.indexOf('==UserScript==') === -1
				&& line.indexOf('==/UserScript==') === -1)
	.reduce((obj: Record<string, string | string[]>, line) => {
		const arr = line.trim().replace(/^\/\//u, '')
			.trim()
			.split(/\s+/u);
		const key = arr[0].slice(1);
		const value = arr.slice(1).join(' ');

		if (!(key in obj)) obj[key] = value;
		else if (Array.isArray(obj[key])) obj[key].push(value);
		else obj[key] = [obj[key], value];

		return obj;
	}, {});

// this could be moved into the ipcRenderer eventlistener but i don't like the idea of a class existing only locally in that arrow function...
/** class for userscripts */
class Userscript implements IUserscriptInstance {

	name: string;

	fullpath: string;

	content: string;

	// parsed metadata, unload function and @run-at
	meta: UserscriptMeta | false;

	unload: Function | false;

	settings: { [key: string]: UserscriptRenderReadySetting };

	settingsPath: string;

	hasRan: boolean; // this is public so settings can just show a "reload page" message when needed

	#strictMode: boolean;

	runAt: ('document-start' | 'document-end') = 'document-end';

	priority: number;

	constructor(props: IUserscript) {
		this.hasRan = false;
		this.#strictMode = false;

		this.name = props.name;
		this.fullpath = props.fullpath;

		this.meta = false;
		this.unload = false;

		this.settingsPath = props.settingsPath;

		this.content = readFileSync(this.fullpath, { encoding: 'utf-8' });
		if (this.content.startsWith('"use strict"')) this.#strictMode = true;
		if (this.content.includes('// ==UserScript==') && this.content.includes('// ==/UserScript==')) {
			let chunk: (string[] | string) = this.content.split('\n');
			chunk = (chunk.length === 1 ? [chunk] : chunk) as string[]; // ensure it's an array
			const startLine = chunk.findIndex(line => line.includes('// ==UserScript=='));
			const endLine = chunk.findIndex(line => line.includes('// ==/UserScript=='));

			if (startLine !== -1 && endLine !== -1) {
				chunk = chunk.slice(startLine, endLine + 1).join('\n');

				/* 
				 * assume this.meta is not false when parsing
				 * fixme: types
				 */
				this.meta = parseMetadata(chunk) as unknown as UserscriptMeta;

				/*
				 * if the metadata define some prop twice, the parser turns it into an array.
				 * we check if a value isArray and if yes, take the last item in that array as the new value
				 */
				for (const metaKey of Object.keys(this.meta) as Array<keyof UserscriptMeta>) {
					const meta = this.meta[metaKey];
					if (Array.isArray(meta)) this.meta[metaKey] = meta[meta.length - 1];
				}

				if ('run-at' in this.meta && this.meta['run-at'] === 'document.start') this.runAt = 'document-start';

				// assign priority 0 incase not defined or invalid type
				this.priority = 0;
				if ('priority' in this.meta && typeof this.meta['priority'] === "string"){
					try {
						this.priority = parseInt(this.meta['priority']);
					} catch (e){
						console.log("Error while parsing userscript priority: ", e);
						this.priority = 0;
					}
				}
			}
		}
	}

	/** runs the userscript */
	load() {
		try {
			// @ts-ignore
			// eslint-disable-next-line @typescript-eslint/no-implied-eval
			const exported = new Function(this.content).apply({
				unload: false,
				settings: {},
				_console: strippedConsole,
				_css: userscriptToggleCSS
			});

			// userscript can return an object with unload and meta properties. use them if it did return
			if (typeof exported !== 'undefined') {
				// more stuff to be added here later
				if ('unload' in exported) this.unload = exported.unload;
				if ('settings' in exported) this.settings = exported.settings;
			}

			// Apply custom settings if they exist
			if (this.settings && Object.keys(this.settings).length > 0 && existsSync(this.settingsPath)) {
				try {
					const settingsJSON: { [key: string]: UserPrefValue } = JSON.parse(readFileSync(this.settingsPath, 'utf-8'));
					Object.keys(settingsJSON).forEach(settingKey => {
						if (customSettingSavedJSONIsNotMalformed(settingKey, this.settings, settingsJSON)) {
							this.settings[settingKey].changed(settingsJSON[settingKey]);
						}
					});
				} catch (err) { // Preferences for script are probably corrupted.
				}
			}

			strippedConsole.log(`%c[cs]${this.#strictMode ? '%c[strict]' : '%c[non-strict]'} %cran %c'${this.name.toString()}' `,
				'color: lightblue; font-weight: bold;', this.#strictMode ? 'color: #62dd4f' : 'color: orange',
				'color: white;', 'color: lightgreen;');
		} catch (error) {
			errAlert(error, this.name);
			strippedConsole.error(error);
		}
	}

}

ipcRenderer.on('main_initializes_userscripts', (event, recieved_userscript_paths: { userscriptsPath: string, userscriptPrefsPath: string }) => {
	su.userscriptsPath = recieved_userscript_paths.userscriptsPath;
	su.userscriptTrackerPath = pathResolve(su.userscriptsPath, 'tracker.json');
	su.userscriptPrefsPath = recieved_userscript_paths.userscriptPrefsPath;

	// init the userscripts (read, map and set up tracker)
	su.userscripts = readdirSync(su.userscriptsPath, { withFileTypes: true })
		.filter(entry => entry.name.endsWith('.js'))
		//                                               v this is so that each custom userscript option will have its own unique file name.  v
		.map(entry => new Userscript({ name: entry.name, settingsPath: pathResolve(su.userscriptPrefsPath, entry.name.replace(/.js$/u, '.json')), fullpath: pathResolve(su.userscriptsPath, entry.name).toString() }));

	const tracker: UserscriptTracker = {};

	su.userscripts.forEach(u => { tracker[u.name] = false; }); // fill tracker with falses, so new userscripts get added disabled
	Object.assign(tracker, JSON.parse(readFileSync(su.userscriptTrackerPath, { encoding: 'utf-8' }))); // read and assign the tracker.json
	writeFileSync(su.userscriptTrackerPath, JSON.stringify(tracker, null, 2), { encoding: 'utf-8' }); // save with the new userscripts

	su.userscriptTracker = tracker;

	// sort userscripts based on priority (descending)
	su.userscripts = su.userscripts.sort((a,b)=>{ return b.priority - a.priority });

	su.userscripts.forEach(u => {
		if (tracker[u.name]) {
			if (u.runAt === 'document-start') {
				u.load();
			} else {
				const callback = () => u.load();
				try { document.removeEventListener('DOMContentLoaded', callback); } catch (e) { }
				document.addEventListener('DOMContentLoaded', callback, { once: true });
			}
		}
	});
});
