// Node modules.
import * as fs from 'fs';
import { promisify } from 'util';
import { google } from 'googleapis';
import { async } from 'rxjs/internal/scheduler/async';
// Local modules.
import { googleApis } from '../config';
import { generateMinimumFont } from './font-minimize';

// If modifying these scopes, delete token.json.
const SCOPES = ['https://www.googleapis.com/auth/spreadsheets'];
const TOKEN_PATH = 'token.json';

export enum MemberStatus {
    公會長 = 1, 副會長, 會員, 離會會員,
}

// Authorize a client with credentials, then call the Google Sheets API.
interface IProfile {
    charName: string;
    displayName: string;
    status: MemberStatus;
    manager: string;
    lineID: string;
    pictureURL: string;
    avatarURL?: string;
    job?: string;
    level?: number;
    unionLevel?: number;
    groups?: string | string[][];
    moodPhrase?: string;
    firstCreated?: string;
    lastUpdated?: string;
    rowNum?: number;
}

interface ISocialData {
    lineID: string;
    displayName: string;
    pictureURL?: string;
    encodedToken: string;
    firstCreated?: string;
    lastUpdated?: string;
    failCount?: number;
}

/**
 * Create an OAuth2 client with the given credentials, and then execute the
 * given callback function.
 * @param {Object} credentials The authorization client credentials.
 * @param {function} callback The callback to call with the authorized client.
 */
async function authorize(credentials: any, callback: any) {
    const { client_secret, client_id, redirect_uris } = credentials.installed;
    const oAuth2Client = new google.auth.OAuth2(client_id, client_secret, redirect_uris[0]);

    // Check if we have previously stored a token.
    try {
        // TODO: avoid locked by sync.
        const token = fs.readFileSync(TOKEN_PATH, { encoding: 'utf-8' });
        oAuth2Client.setCredentials(JSON.parse(token));
        await callback(oAuth2Client);
    } catch (err) {
        throw {
            errorCode: 'ERR_ACCESS_TOKEN_FAIL',
            error: err,
        };
    }
}

/**
 * Get and store new token after prompting for user authorization, and then
 * execute the given callback with the authorized OAuth2 client.
 * @param {google.auth.OAuth2} oAuth2Client The OAuth2 client to get token for.
 * @param {getEventsCallback} callback The callback for the authorized client.
 */
function getNewToken(oAuth2Client: any, callback: any) {
    const authUrl = oAuth2Client.generateAuthUrl({
        access_type: 'offline',
        scope: SCOPES,
    });

    callback(authUrl);
}


function _initialize(credentials: any, callback: any) {
    const { client_secret, client_id, redirect_uris } = credentials.installed;
    const oAuth2Client = new google.auth.OAuth2(client_id, client_secret, redirect_uris[0]);

    getNewToken(oAuth2Client, callback);
}

function _generateToken(code: string) {
    const { client_secret, client_id, redirect_uris } = credentials.installed;
    const oAuth2Client = new google.auth.OAuth2(client_id, client_secret, redirect_uris[0]);

    oAuth2Client.getToken(code, (err: any, token: any) => {
        if (err) {
            return console.error('Error while trying to retrieve access token', err);
        }

        // Store the token to disk for later program executions.
        fs.writeFileSync(TOKEN_PATH, JSON.stringify(token));
    });
}

async function _getMembers() {
    const sheets = google.sheets({
        version: 'v4',
        auth: googleApis.apiKey,
    });

    const getValues = promisify(sheets.spreadsheets.values.get);

    try {
        const res = await getValues({
            spreadsheetId: googleApis.spreadsheetId,
            range: `${googleApis.memberSheetName}!A2:M`,
        });

        const rows: string[][] = res.data.values;
        const members: IProfile[] = rows.map((row) => ({
            charName: row[0],
            displayName: row[1],
            status: MemberStatus[row[2] as any] as any,
            manager: row[3],
            lineID: row[4],
            pictureURL: row[5],
            avatarURL: row[6],
            job: row[7],
            level: parseInt(row[8]),
            unionLevel: parseInt(row[9]),
            groups: row[10].split(',').filter(Boolean).map((o) => o.split('-')),
            moodPhrase: row[11],
            firstCreated: row[12],
            lastUpdated: row[123],
        }));

        return members;
    } catch (err) {
        console.warn(`ERR_LOAD_MEMBERS_DATA`, err);
        return [];
    }
}

async function _addMember(profile: IProfile, social: ISocialData, callback: any, auth: any) {
    const sheets = google.sheets({
        version: 'v4',
        auth,
    });

    // Avoid duplicate member be added.
    const members = await _getMembers();
    const found = members.find((member) => member.lineID === profile.lineID);

    if (found) {
        return callback('ERR_MEMBER_ALREADY_EXIST');
    }

    const appendValues = promisify(sheets.spreadsheets.values.append);

    try {
        const res = await appendValues({
            auth,
            spreadsheetId: googleApis.spreadsheetId,
            range: `${googleApis.memberSheetName}!A2`,
            includeValuesInResponse: false,
            insertDataOption: 'INSERT_ROWS',
            responseDateTimeRenderOption: 'FORMATTED_STRING',
            responseValueRenderOption: 'UNFORMATTED_VALUE',
            valueInputOption: 'RAW',
            resource: {
                'values': [
                    [
                        profile.charName,
                        profile.displayName,
                        MemberStatus[profile.status],
                        profile.manager,
                        profile.lineID,
                        profile.pictureURL,
                        profile.avatarURL,
                        profile.job,
                        profile.level,
                        profile.unionLevel,
                        undefined, // Empty groups.
                        undefined, // Empty mood phrase.
                        (new Date).toLocaleString(),
                        (new Date).toLocaleString(),
                    ]
                ]
            },
        });

        const res2 = await appendValues({
            auth,
            spreadsheetId: googleApis.spreadsheetId,
            range: `${googleApis.lineProfileSheetName}!A2`,
            includeValuesInResponse: false,
            insertDataOption: 'INSERT_ROWS',
            responseDateTimeRenderOption: 'FORMATTED_STRING',
            responseValueRenderOption: 'UNFORMATTED_VALUE',
            valueInputOption: 'RAW',
            resource: {
                'values': [
                    [
                        social.lineID,
                        social.displayName,
                        social.pictureURL,
                        social.encodedToken,
                        (new Date).toLocaleString(),
                        (new Date).toLocaleString(),
                    ]
                ]
            },
        });

        // Refresh the members data.
        await taskRefreshMembersData();

        return callback(null);
    } catch (err) {
        return callback('ERR_APPEND_VALUES');
    }
}

async function _getLineProfiles() {
    const sheets = google.sheets({
        version: 'v4',
        auth: googleApis.apiKey,
    });

    const getValues = promisify(sheets.spreadsheets.values.get);

    try {
        const res = await getValues({
            spreadsheetId: googleApis.spreadsheetId,
            range: `${googleApis.lineProfileSheetName}!A2:G`,
        });

        const rows: string[][] = res.data.values;
        const socialDatas: ISocialData[] = rows.map((row) => ({
            lineID: row[0],
            displayName: row[1],
            pictureURL: row[2] as any,
            encodedToken: row[3],
            firstCreated: row[4],
            lastUpdated: row[5],
            failCount: parseInt(row[6]),
        }));

        return socialDatas;
    } catch (err) {
        return [];
    }
}

async function _updateLineProfile(rowNum: number, social: ISocialData, callback: any, auth: any) {
    const sheets = google.sheets({
        version: 'v4',
        auth,
    });

    const batchUpdate = promisify(sheets.spreadsheets.values.batchUpdate);

    try {
        // Update sheet 'members' and 'line_profiles'.
        const res = await batchUpdate({
            auth,
            spreadsheetId: googleApis.spreadsheetId,
            resource: {
                valueInputOption: 'RAW',
                data: [
                    {
                        range: `${googleApis.memberSheetName}!B${rowNum}:F`,
                        values: [[
                            social.displayName,
                            undefined,                   // Status.
                            undefined,                   // Manager.
                            undefined,                   // LINE ID.
                            social.pictureURL,
                        ]],
                    },
                    {
                        range: `${googleApis.memberSheetName}!N${rowNum}`,
                        values: [[
                            (new Date).toLocaleString(), // Last update time.
                        ]],
                    },
                    {
                        range: `${googleApis.lineProfileSheetName}!A${rowNum}:G`,
                        values: [[
                            undefined,                   // LINE ID, won't replace. 
                            social.displayName,
                            social.pictureURL,
                            undefined,                   // Encoded token.
                            undefined,                   // First create time.
                            (new Date).toLocaleString(), // Last update time.
                            social.failCount,            // Count of failure.
                        ]],
                    },
                ],
            },
        });

        return callback(null);
    } catch (err) {
        return callback('ERR_UPDATE_VALUES', err.errors);
    }
}

async function _updateCharData(rowNum: number, profile: Partial<IProfile>, callback: any, auth: any) {
    const sheets = google.sheets({
        version: 'v4',
        auth,
    });

    const batchUpdate = promisify(sheets.spreadsheets.values.batchUpdate);

    try {
        // Update sheet 'members' and 'line_profiles'.
        const res = await batchUpdate({
            auth,
            spreadsheetId: googleApis.spreadsheetId,
            resource: {
                valueInputOption: 'RAW',
                data: [
                    {
                        range: `${googleApis.memberSheetName}!G${rowNum}:J`,
                        values: [[
                            profile.avatarURL,           // Avatar URL.
                            profile.job,                 // Job of character.
                            profile.level,               // Level of character.
                            profile.unionLevel,          // Union level of character.
                        ]],
                    },
                    {
                        range: `${googleApis.memberSheetName}!N${rowNum}`,
                        values: [[
                            (new Date).toLocaleString(), // Last update time.
                        ]],
                    },
                ],
            },
        });

        return callback(null);
    } catch (err) {
        return callback('ERR_UPDATE_VALUES', err.errors);
    }
}

async function _updateMoodPhrase(lineID: string, moodPhrase: string, callback: any, auth: any) {
    const sheets = google.sheets({
        version: 'v4',
        auth,
    });

    const batchUpdate = promisify(sheets.spreadsheets.values.batchUpdate);

    try {
        const found = await findMember(lineID);
        if (found) {
            // Update sheet 'members' and 'line_profiles'.
            const res = await batchUpdate({
                auth,
                spreadsheetId: googleApis.spreadsheetId,
                resource: {
                    valueInputOption: 'RAW',
                    data: [
                        {
                            range: `${googleApis.memberSheetName}!L${found.rowNum}`,
                            values: [[ moodPhrase ]],
                        }
                    ],
                },
            });
        }

        return callback(null);
    } catch (err) {
        return callback('ERR_UPDATE_VALUES', err.errors);
    }
}

/**
 * Schedules for updating data.
 */

// Load client secrets from a local file.
const content = fs.readFileSync('./credentials.json', { encoding: 'utf-8' });
const credentials = JSON.parse(content);

// Refresh member data automatically.
let membersData: { members: IProfile[], lastUpdated: string };
async function taskRefreshMembersData(this: any) {
    membersData = {
        members: (await _getMembers())
            .map((o, i) => ({ ...o, rowNum: i + 2 })) // 2 is a magic !
            .sort((a, b) => Math.random() - Math.random()) // shuffle.
            .sort((a, b) => a.status - b.status)
            .filter((o) => o.status <= MemberStatus.會員),
        lastUpdated: (new Date).toLocaleString(),
    };
    // Generate font.
    generateMinimumFont(JSON.stringify(membersData));
    if (this) {
        // Next task.
        this.schedule(undefined, 10000);
        console.log(`[Member data] Auto refreshed. Loaded ${membersData.members.length} members.`);
    } else {
        console.log(`[Member data] Refreshed. Loaded ${membersData.members.length} members.`);
    }
}
async.schedule(taskRefreshMembersData, 0);

/**
 * Export values or functions.
 */

export const initialize = (errorHandler: any) =>
    authorize(credentials, () => null)
        .catch((e) => _initialize(credentials, errorHandler));

export const generateToken = async (code: string) =>
    authorize(credentials, () => null)
        .catch((e) => _generateToken(code));

export const addMember = async (profile: IProfile, social: ISocialData, errorHandler: any) =>
    await authorize(credentials, _addMember.bind(null, profile, social, errorHandler))
        .catch((e) => console.error(e));

export const updateLineProfile = async (rowNum: number, social: ISocialData, errorHandler: any) =>
    await authorize(credentials, _updateLineProfile.bind(null, rowNum, social, errorHandler))
        .catch((e) => console.error(e));

export const updateCharData = async (rowNum: number, profile: Partial<IProfile>, errorHandler: any) =>
    await authorize(credentials, _updateCharData.bind(null, rowNum, profile, errorHandler))
        .catch((e) => console.error(e));

export const updateMoodPhrase = async (lineID: string, moodPhrase: string, errorHandler: any) =>
    await authorize(credentials, _updateMoodPhrase.bind(null, lineID, moodPhrase, errorHandler))
        .catch((e) => console.error(e));

export const getMembersData = () => membersData;

export const getLineProfiles = _getLineProfiles;

export const findMember = async (lineID: string) => {
    if (membersData && membersData.members) {
        const found = membersData.members.find((member) => member.lineID === lineID);
        return found;
    }
    return undefined;
};
