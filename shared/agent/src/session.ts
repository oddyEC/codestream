"use strict";

import { Agent as HttpAgent } from "http";
import { Agent as HttpsAgent } from "https";
import HttpsProxyAgent from "https-proxy-agent";
import { isEqual } from "lodash-es";
import * as path from "path";
import * as url from "url";
import {
	CancellationToken,
	Connection,
	Emitter,
	Event,
	MessageActionItem,
	WorkspaceFolder
} from "vscode-languageserver";
import { CodeStreamAgent } from "./agent";
import { AgentError, ServerError } from "./agentError";
import {
	ApiProvider,
	ApiProviderLoginResponse,
	CodeStreamApiMiddlewareContext,
	LoginOptions,
	MessageType,
	RTMessage
} from "./api/apiProvider";
import { CodeStreamApiProvider } from "./api/codestream/codestreamApi";
import {
	ApiVersionCompatibilityChangedEvent,
	VersionCompatibilityChangedEvent,
	VersionMiddlewareManager
} from "./api/middleware/versionMiddleware";
import { Container, SessionContainer } from "./container";
import { DocumentEventHandler } from "./documentEventHandler";
import { GitRepository } from "./git/models/repository";
import { Logger } from "./logger";
import {
	ApiRequestType,
	ApiVersionCompatibility,
	BaseAgentOptions,
	BootstrapRequestType,
	ChangeDataType,
	CodeStreamEnvironment,
	ConfirmRegistrationRequest,
	ConfirmRegistrationRequestType,
	ConnectionStatus,
	DidChangeApiVersionCompatibilityNotificationType,
	DidChangeConnectionStatusNotificationType,
	DidChangeDataNotificationType,
	DidChangeServerUrlNotificationType,
	DidChangeVersionCompatibilityNotificationType,
	DidEncounterMaintenanceModeNotificationType,
	DidFailLoginNotificationType,
	DidLoginNotificationType,
	DidLogoutNotificationType,
	DidSetEnvironmentNotificationType,
	DidStartLoginNotificationType,
	GetAccessTokenRequestType,
	GetInviteInfoRequest,
	GetInviteInfoRequestType,
	isLoginFailResponse,
	LoginResponse,
	LogoutReason,
	OtcLoginRequest,
	OtcLoginRequestType,
	PasswordLoginRequest,
	PasswordLoginRequestType,
	RegisterUserRequest,
	RegisterUserRequestType,
	ReportingMessageType,
	SetServerUrlRequest,
	SetServerUrlRequestType,
	ThirdPartyProviders,
	TokenLoginRequest,
	TokenLoginRequestType,
	UIStateRequestType,
	UserDidCommitNotificationType,
	VerifyConnectivityRequestType,
	VerifyConnectivityResponse,
	VersionCompatibility
} from "./protocol/agent.protocol";
import {
	CSApiCapabilities,
	CSCodemark,
	CSCompany,
	CSLoginResponse,
	CSMarker,
	CSMarkerLocations,
	CSMe,
	CSMePreferences,
	CSPost,
	CSRegisterResponse,
	CSRepository,
	CSStream,
	CSTeam,
	CSUser,
	LoginResult
} from "./protocol/api.protocol";
import { log, memoize, registerDecoratedHandlers, registerProviders } from "./system";
import { testGroups } from "./testGroups";

const envRegex = /https?:\/\/((?:(\w+)-)?api|localhost|(\w+))\.codestream\.(?:us|com)(?::\d+$)?/i;

const FIRST_SESSION_TIMEOUT = 12 * 60 * 60 * 1000; // first session "times out" after 12 hours

export const loginApiErrorMappings: { [k: string]: LoginResult } = {
	"USRC-1001": LoginResult.InvalidCredentials,
	"USRC-1010": LoginResult.NotConfirmed,
	"AUTH-1002": LoginResult.InvalidToken,
	"AUTH-1003": LoginResult.InvalidToken,
	"AUTH-1004": LoginResult.ExpiredToken,
	"AUTH-1005": LoginResult.ExpiredToken,
	"USRC-1005": LoginResult.InvalidToken,
	"USRC-1002": LoginResult.InvalidToken,
	"USRC-1006": LoginResult.AlreadyConfirmed,
	// "RAPI-1001": "missing parameter" // shouldn't ever happen
	"RAPI-1003": LoginResult.InvalidToken,
	"USRC-1012": LoginResult.NotOnTeam,
	"VERS-1001": LoginResult.VersionUnsupported,
	"USRC-1023": LoginResult.MaintenanceMode,
	"USRC-1024": LoginResult.MustSetPassword,
	"USRC-1022": LoginResult.ProviderConnectFailed,
	"USRC-1015": LoginResult.MultipleWorkspaces, // deprecated in favor of below...
	"PRVD-1002": LoginResult.MultipleWorkspaces,
	"PRVD-1005": LoginResult.SignupRequired,
	"PRVD-1006": LoginResult.SignInRequired,
	"USRC-1020": LoginResult.InviteConflict,
	"AUTH-1006": LoginResult.TokenNotFound
};

export enum SessionStatus {
	SignedOut = "signedOut",
	SignedIn = "signedIn"
}

export interface SessionStatusChangedEvent {
	getStatus(): SessionStatus;
	session: CodeStreamSession;
}

export interface TelemetryData {
	hasCreatedPost: boolean;
}

export interface VersionInfo {
	extension: {
		build: string;
		buildEnv: string;
		version: string;
		versionFormatted: string;
	};

	ide: {
		name: string;
		version: string;
		detail: string;
	};

	machine?: {
		machineId?: string;
	};
}

export class CodeStreamSession {
	private _onDidChangeCodemarks = new Emitter<CSCodemark[]>();
	get onDidChangeCodemarks(): Event<CSCodemark[]> {
		return this._onDidChangeCodemarks.event;
	}

	private _onDidChangeCurrentUser = new Emitter<CSMe>();
	get onDidChangeCurrentUser(): Event<CSMe> {
		return this._onDidChangeCurrentUser.event;
	}

	private _onDidChangePreferences = new Emitter<CSMePreferences>();
	get onDidChangePreferences(): Event<CSMePreferences> {
		return this._onDidChangePreferences.event;
	}

	private _onDidChangeMarkerLocations = new Emitter<CSMarkerLocations[]>();
	get onDidChangeMarkerLocations(): Event<CSMarkerLocations[]> {
		return this._onDidChangeMarkerLocations.event;
	}

	private _onDidChangeMarkers = new Emitter<CSMarker[]>();
	get onDidChangeMarkers(): Event<CSMarker[]> {
		return this._onDidChangeMarkers.event;
	}

	private _onDidChangePosts = new Emitter<CSPost[]>();
	get onDidChangePosts(): Event<CSPost[]> {
		return this._onDidChangePosts.event;
	}

	private _onDidChangeRepositories = new Emitter<CSRepository[]>();
	get onDidChangeRepositories(): Event<CSRepository[]> {
		return this._onDidChangeRepositories.event;
	}

	private _onDidChangeStreams = new Emitter<CSStream[]>();
	get onDidChangeStreams(): Event<CSStream[]> {
		return this._onDidChangeStreams.event;
	}

	private _onDidChangeUsers = new Emitter<CSUser[]>();
	get onDidChangeUsers(): Event<CSUser[]> {
		return this._onDidChangeUsers.event;
	}

	private _onDidChangeTeams = new Emitter<CSTeam[]>();
	get onDidChangeTeams(): Event<CSTeam[]> {
		return this._onDidChangeTeams.event;
	}

	private _onDidRequestReset = new Emitter<void>();
	get onDidRequestReset(): Event<void> {
		return this._onDidRequestReset.event;
	}

	private _onDidChangeSessionStatus = new Emitter<SessionStatusChangedEvent>();
	get onDidChangeSessionStatus(): Event<SessionStatusChangedEvent> {
		return this._onDidChangeSessionStatus.event;
	}

	get proxyAgent(): HttpsAgent | HttpsProxyAgent | undefined {
		return this._httpsAgent;
	}

	private readonly _httpsAgent: HttpsAgent | HttpsProxyAgent | undefined;
	private readonly _httpAgent: HttpAgent | undefined; // used if api server is http
	private readonly _readyPromise: Promise<void>;
	// in-memory store of what UI the user is current looking at
	private uiState: string | undefined;
	private _documentEventHandler: DocumentEventHandler | undefined;

	// HACK in certain scenarios the agent may want to use more performance-intensive
	// operations when handling document change and saves. This is true for when
	// a user is looking at the review screen, where we need to be able to live-update
	// the view based on documents changing & saving, as well as git operations removing
	// and/or squashing commits.
	get useEnhancedDocumentChangeHandler(): boolean {
		return this.uiState === "new-review" || this.uiState === "people";
	}

	constructor(
		public readonly agent: CodeStreamAgent,
		private readonly _connection: Connection,
		private readonly _options: BaseAgentOptions
	) {
		this._readyPromise = new Promise<void>(resolve =>
			this.agent.onReady(() => {
				Logger.log("Agent is ready");
				resolve();
			})
		);

		Container.initialize(agent, this);

		const redactProxyPasswdRegex = /(http:\/\/.*:)(.*)(@.*)/gi;
		if (
			_options.proxySupport === "override" ||
			(_options.proxySupport == null && _options.proxy != null)
		) {
			if (_options.proxy != null) {
				const redactedUrl = _options.proxy.url.replace(redactProxyPasswdRegex, "$1*****$3");
				Logger.log(
					`Proxy support is in override with url=${redactedUrl}, strictSSL=${_options.proxy.strictSSL}`
				);
				this._httpsAgent = new HttpsProxyAgent({
					...url.parse(_options.proxy.url),
					rejectUnauthorized: _options.proxy.strictSSL
				} as any);
			} else {
				Logger.log("Proxy support is in override, but no proxy settings were provided");
			}
		} else if (_options.proxySupport === "on") {
			const proxyUrl = process.env.HTTPS_PROXY || process.env.HTTP_PROXY;
			if (proxyUrl) {
				const strictSSL = _options.proxy ? _options.proxy.strictSSL : true;
				const redactedUrl = proxyUrl.replace(redactProxyPasswdRegex, "$1*****$3");
				Logger.log(`Proxy support is on with url=${redactedUrl}, strictSSL=${strictSSL}`);

				let proxyUri;
				try {
					proxyUri = url.parse(proxyUrl);
				} catch {}

				if (proxyUri) {
					this._httpsAgent = new HttpsProxyAgent({
						...proxyUri,
						rejectUnauthorized: this.rejectUnauthorized
					} as any);
				}
			} else {
				Logger.log("Proxy support is on, but no proxy url was found");
			}
		} else {
			Logger.log("Proxy support is off");
		}

		if (!this._httpsAgent) {
			this._httpsAgent = new HttpsAgent({
				rejectUnauthorized: this.rejectUnauthorized
			});
		}

		// if our api server is http (on-prem installation), create a separate http agent
		const protocol = url.parse(_options.serverUrl).protocol;
		if (protocol === "http:") {
			this._httpAgent = new HttpAgent();
		}

		this._api = new CodeStreamApiProvider(
			_options.serverUrl,
			this.versionInfo,
			this._httpAgent || this._httpsAgent,
			this.rejectUnauthorized
		);

		this._api.useMiddleware({
			get name() {
				return "MaintenanceMode";
			},

			onResponse: async (context: Readonly<CodeStreamApiMiddlewareContext>, _) => {
				if (
					context.response?.headers.get("X-CS-API-Maintenance-Mode") &&
					this._codestreamAccessToken
				) {
					this._didEncounterMaintenanceMode();
				}
			}
		});

		this._api.verifyConnectivity().then(response => {
			if (!response.environment) {
				// for versions of api server pre 8.2.34, which did not support returning environment
				// in connectivity response ... this code can be eliminated once we're enforcing
				// versions higher than this
				const [environment, isOnPrem] = this.getEnvironmentFromServerUrl(this._options.serverUrl);
				this._environment = environment;
				this._isOnPrem = environment === "onprem" || isOnPrem;
			} else {
				this._environment = response.environment;
				this._isOnPrem = response.isOnPrem || false;
			}
			this.agent.sendNotification(DidSetEnvironmentNotificationType, {
				environment: this._environment,
				isOnPrem: this._isOnPrem
			});
		});
		const versionManager = new VersionMiddlewareManager(this._api);
		versionManager.onDidChangeCompatibility(this.onVersionCompatibilityChanged, this);
		versionManager.onDidChangeApiCompatibility(this.onApiVersionCompatibilityChanged, this);

		// this.connection.onHover(e => MarkerHandler.onHover(e));

		registerDecoratedHandlers(this.agent);

		this.agent.registerHandler(UIStateRequestType, e => {
			if (e && e.context && e.context.panelStack && e.context.panelStack[0]) {
				this.uiState = e.context.panelStack[0];
			} else {
				this.uiState = undefined;
			}
		});

		this.agent.registerHandler(VerifyConnectivityRequestType, () => this.verifyConnectivity());
		this.agent.registerHandler(GetAccessTokenRequestType, e => {
			return { accessToken: this._codestreamAccessToken! };
		});
		this.agent.registerHandler(PasswordLoginRequestType, e => this.passwordLogin(e));
		this.agent.registerHandler(TokenLoginRequestType, e => this.tokenLogin(e));
		this.agent.registerHandler(OtcLoginRequestType, e => this.otcLogin(e));
		this.agent.registerHandler(RegisterUserRequestType, e => this.register(e));
		this.agent.registerHandler(ConfirmRegistrationRequestType, e => this.confirmRegistration(e));
		this.agent.registerHandler(GetInviteInfoRequestType, e => this.getInviteInfo(e));
		this.agent.registerHandler(ApiRequestType, (e, cancellationToken: CancellationToken) =>
			this.api.fetch(e.url, e.init, e.token)
		);
		this.agent.registerHandler(SetServerUrlRequestType, e => this.setServerUrl(e));
		this.agent.registerHandler(
			BootstrapRequestType,
			async (e, cancellationToken: CancellationToken) => {
				const { companies, repos, streams, teams, users } = SessionContainer.instance();
				const promise = Promise.all([
					companies.get(),
					repos.get(),
					streams.get(),
					teams.get(),
					users.getUnreads({}),
					users.get(),
					users.getPreferences()
				]);

				const [
					companiesResponse,
					reposResponse,
					streamsResponse,
					teamsResponse,
					unreadsResponse,
					usersResponse,
					preferencesResponse
				] = await promise;

				return {
					companies: companiesResponse.companies,
					preferences: preferencesResponse.preferences,
					repos: reposResponse.repos,
					streams: streamsResponse.streams,
					teams: teamsResponse.teams,
					unreads: unreadsResponse.unreads,
					users: usersResponse.users,
					providers: this.providers,
					apiCapabilities: this.apiCapabilities,
					environment: this.environment,
					isOnPrem: this.isOnPrem
				};
			}
		);
	}

	setServerUrl(options: SetServerUrlRequest) {
		this._options.serverUrl = options.serverUrl;
		this._options.disableStrictSSL = options.disableStrictSSL;
		this._api?.setServerUrl(this._options.serverUrl);
		this.agent.sendNotification(DidChangeServerUrlNotificationType, {
			serverUrl: options.serverUrl
		});
	}

	private _didEncounterMaintenanceMode() {
		this.agent.sendNotification(DidEncounterMaintenanceModeNotificationType, {
			teamId: this._teamId,
			token: {
				email: this._email!,
				url: this._options.serverUrl,
				value: this._codestreamAccessToken!
			}
		});
	}

	private async onRTMessageReceived(e: RTMessage) {
		switch (e.type) {
			case MessageType.Codemarks:
				const codemarks = await SessionContainer.instance().codemarks.enrichCodemarks(e.data);
				this._onDidChangeCodemarks.fire(codemarks);
				this.agent.sendNotification(DidChangeDataNotificationType, {
					type: ChangeDataType.Codemarks,
					data: codemarks
				});
				break;
			case MessageType.Companies:
				this.agent.sendNotification(DidChangeDataNotificationType, {
					type: ChangeDataType.Companies,
					data: e.data
				});
				break;
			case MessageType.Connection:
				if (e.data.status === ConnectionStatus.Reconnected && e.data.reset) {
					void SessionContainer.instance().session.reset();
				}

				this.agent.sendNotification(DidChangeConnectionStatusNotificationType, e.data);
				break;
			case MessageType.MarkerLocations:
				this._onDidChangeMarkerLocations.fire(e.data);
				this.agent.sendNotification(DidChangeDataNotificationType, {
					type: ChangeDataType.MarkerLocations,
					data: e.data
				});
				break;
			case MessageType.Markers:
				this._onDidChangeMarkers.fire(e.data);
				this.agent.sendNotification(DidChangeDataNotificationType, {
					type: ChangeDataType.Markers,
					data: e.data
				});
				break;
			case MessageType.Posts:
				const posts = await SessionContainer.instance().posts.enrichPosts(e.data);
				this._onDidChangePosts.fire(posts);
				this.agent.sendNotification(DidChangeDataNotificationType, {
					type: ChangeDataType.Posts,
					data: posts
				});
				break;
			case MessageType.Preferences:
				this._onDidChangePreferences.fire(e.data);
				this.agent.sendNotification(DidChangeDataNotificationType, {
					type: ChangeDataType.Preferences,
					data: e.data
				});
				break;
			case MessageType.Repositories:
				this._onDidChangeRepositories.fire(e.data);
				this.agent.sendNotification(DidChangeDataNotificationType, {
					type: ChangeDataType.Repositories,
					data: e.data
				});
				break;
			case MessageType.Reviews:
				this.agent.sendNotification(DidChangeDataNotificationType, {
					type: ChangeDataType.Reviews,
					data: e.data
				});
				break;
			case MessageType.Streams:
				this._onDidChangeStreams.fire(e.data);
				this.agent.sendNotification(DidChangeDataNotificationType, {
					type: ChangeDataType.Streams,
					data: e.data
				});
				break;
			case MessageType.Teams:
				this._onDidChangeTeams.fire(e.data);
				this.agent.sendNotification(DidChangeDataNotificationType, {
					type: ChangeDataType.Teams,
					data: e.data
				});
				break;
			case MessageType.Unreads:
				this.agent.sendNotification(DidChangeDataNotificationType, {
					type: ChangeDataType.Unreads,
					data: e.data
				});
				break;
			case MessageType.Users:
				const me = e.data.find(u => u.id === this._userId) as CSMe | undefined;
				if (me != null) {
					if (me.inMaintenanceMode) {
						return this._didEncounterMaintenanceMode();
					}
					this._onDidChangeCurrentUser.fire(me as CSMe);
				}

				this._onDidChangeUsers.fire(e.data);
				this.agent.sendNotification(DidChangeDataNotificationType, {
					type: ChangeDataType.Users,
					data: e.data
				});
				break;
		}
	}

	@log()
	private onVersionCompatibilityChanged(e: VersionCompatibilityChangedEvent) {
		this.agent.sendNotification(DidChangeVersionCompatibilityNotificationType, e);

		if (e.compatibility === VersionCompatibility.UnsupportedUpgradeRequired) {
			this.logout(LogoutReason.UnsupportedVersion);
		}
	}

	@log()
	private async onApiVersionCompatibilityChanged(e: ApiVersionCompatibilityChangedEvent) {
		this.agent.sendNotification(DidChangeApiVersionCompatibilityNotificationType, e);

		if (
			e.compatibility !== ApiVersionCompatibility.ApiUpgradeRequired &&
			SessionContainer.isInitialized()
		) {
			const oldCapabilities = SessionContainer.instance().session.apiCapabilities;
			const newCapabilities = await this.api.getApiCapabilities();
			const currentTeam = await SessionContainer.instance().teams.getByIdFromCache(this.teamId);
			if (!isEqual(oldCapabilities, newCapabilities)) {
				this.registerApiCapabilities(newCapabilities, currentTeam);
				this.agent.sendNotification(DidChangeDataNotificationType, {
					type: ChangeDataType.ApiCapabilities,
					data: newCapabilities
				});
			}
		}
	}

	private _api: ApiProvider | undefined;
	get api() {
		return this._api!;
	}

	private _codestreamUserId: string | undefined;
	get codestreamUserId() {
		return this._codestreamUserId!;
	}

	private _email: string | undefined;
	get email() {
		return this._email!;
	}

	private _codestreamAccessToken: string | undefined;
	get codestreamAccessToken() {
		return this._codestreamAccessToken;
	}

	private _environment: CodeStreamEnvironment | string = CodeStreamEnvironment.Unknown;
	get environment() {
		if (this._environment === CodeStreamEnvironment.Unknown) {
			if (this._options.serverUrl) {
				// this should only be called before we have communicated with the server,
				// which is regarded as the source of truth
				// for now, this is only needed by the error reporter initialization in errorReporter.ts
				// we should keep it that way
				const [environment, isOnPrem] = this.getEnvironmentFromServerUrl(this._options.serverUrl);
				this._environment = environment;
				this._isOnPrem = isOnPrem;
			}
		}
		return this._environment;
	}

	private _isOnPrem: boolean = false;
	get isOnPrem() {
		return this._isOnPrem;
	}

	get disableStrictSSL(): boolean {
		return this._options.disableStrictSSL != null ? this._options.disableStrictSSL : false;
	}

	get rejectUnauthorized(): boolean {
		return !this.disableStrictSSL;
	}

	private _status: SessionStatus = SessionStatus.SignedOut;
	get status() {
		return this._status;
	}
	private setStatus(status: SessionStatus) {
		this._status = status;
		const e: SessionStatusChangedEvent = {
			getStatus: () => this._status,
			session: this
		};

		this._onDidChangeSessionStatus.fire(e);
	}

	private _teamId: string | undefined;
	get teamId() {
		return this._teamId!;
	}

	private _apiCapabilities: CSApiCapabilities = {};
	get apiCapabilities() {
		return this._apiCapabilities;
	}

	private _telemetryData: TelemetryData = {
		hasCreatedPost: false
	};
	get telemetryData() {
		return this._telemetryData;
	}
	set telemetryData(data: TelemetryData) {
		this._telemetryData = data;
	}

	private _userId: string | undefined;
	get userId() {
		return this._userId!;
	}

	private _providers: ThirdPartyProviders = {};
	get providers() {
		return this._providers!;
	}

	@memoize
	get versionInfo(): Readonly<VersionInfo> {
		return {
			extension: { ...this._options.extension },
			ide: { ...this._options.ide },
			machine: { machineId: this._options.machineId }
		};
	}

	get workspace() {
		return this._connection.workspace;
	}

	public async getWorkspaceFolders() {
		if (this._options.workspaceFolders) {
			Logger.log(
				`getWorkspaceFolders: ${this._options.workspaceFolders.length} preconfigured folders found`
			);
			return this._options.workspaceFolders;
		}

		if (this.agent.supportsWorkspaces) {
			try {
				Logger.log("getWorkspaceFolders: workspaces supported");
				return (await this.workspace.getWorkspaceFolders()) || [];
			} catch (ex) {
				// if you're here, ensure you've waited for the agent to be ready
				debugger;
			}
		}

		Logger.log("getWorkspaceFolders: workspaces not supported");
		return new Promise<WorkspaceFolder[] | null>((resolve, reject) => {
			try {
				if (this.agent.rootUri) {
					const uri =
						this.agent.rootUri[this.agent.rootUri.length - 1] === "/"
							? this.agent.rootUri.substring(0, this.agent.rootUri.length - 1)
							: this.agent.rootUri;
					resolve([
						{
							uri: uri,
							name: path.basename(this.agent.rootUri)
						}
					]);
				} else {
					resolve([]);
				}
			} catch (e) {
				Logger.error(e);
				reject(e);
			}
		});
	}

	@log({ singleLine: true })
	async verifyConnectivity(): Promise<VerifyConnectivityResponse> {
		return this.api.verifyConnectivity();
	}

	@log({ singleLine: true })
	async passwordLogin(request: PasswordLoginRequest) {
		const cc = Logger.getCorrelationContext();
		Logger.log(
			cc,
			`Logging ${request.email} into CodeStream (@ ${this._options.serverUrl}) via password`
		);

		return this.login({
			type: "credentials",
			...request
		});
	}

	@log({ singleLine: true })
	async tokenLogin(request: TokenLoginRequest) {
		const { token } = request;
		const cc = Logger.getCorrelationContext();
		Logger.log(
			cc,
			`Logging ${token.email} into CodeStream (@ ${token.url}) via authentication token...`
		);

		return this.login({
			type: "token",
			...request
		});
	}

	@log({ singleLine: true })
	async otcLogin(request: OtcLoginRequest) {
		const cc = Logger.getCorrelationContext();
		Logger.log(cc, `Logging into CodeStream (@ ${this._options.serverUrl}) via otc code...`);

		try {
			return this.login({
				type: "otc",
				...request
			});
		} catch (e) {
			debugger;
			throw new Error();
		}
	}

	@log({
		singleLine: true
	})
	async login(options: LoginOptions): Promise<LoginResponse> {
		if (this.status === SessionStatus.SignedIn) {
			Container.instance().errorReporter.reportMessage({
				type: ReportingMessageType.Warning,
				source: "agent",
				message: "There was a redundant attempt to login while already logged in.",
				extra: {
					loginType: options.type
				}
			});
			return { error: LoginResult.AlreadySignedIn };
		}

		this.agent.sendNotification(DidStartLoginNotificationType, undefined);

		let response: ApiProviderLoginResponse;
		try {
			response = await this.api.login(options);
		} catch (ex) {
			this.agent.sendNotification(DidFailLoginNotificationType, undefined);
			if (ex instanceof ServerError) {
				if (ex.statusCode !== undefined && ex.statusCode >= 400 && ex.statusCode < 500) {
					let error = loginApiErrorMappings[ex.info.code] || LoginResult.Unknown;
					if (error === LoginResult.ProviderConnectFailed) {
						Container.instance().telemetry.track({
							eventName: "Provider Connect Failed",
							properties: {
								Error: ex.info && ex.info.error,
								Provider: ex.info && ex.info.provider
							}
						});
						// map the reason for provider auth failure
						error = loginApiErrorMappings[ex.info.error];
					}
					return {
						error: error,
						extra: ex.info
					};
				}
			}

			// api.login() will throw a failed response object if it needs to send some extra data back
			if (isLoginFailResponse(ex)) {
				return ex;
			}

			Container.instance().errorReporter.reportMessage({
				type: ReportingMessageType.Error,
				message: "Unexpected error logging in",
				source: "agent",
				extra: {
					...ex
				}
			});
			throw AgentError.wrap(ex, `Login failed:\n${ex.message}`);
		}

		const token = response.token;
		this._codestreamAccessToken = token.value;
		this._teamId = (this._options as any).teamId = token.teamId;
		this._codestreamUserId = response.user.id;
		this._environment = response.runtimeEnvironment || CodeStreamEnvironment.Production;
		this._isOnPrem =
			response.isOnPrem === undefined // this check obsolete as of api server version 8.2.34
				? response.runtimeEnvironment === "onprem"
				: response.isOnPrem;

		const currentTeam = response.teams.find(t => t.id === this._teamId)!;
		this.registerApiCapabilities(response.capabilities || {}, currentTeam);

		if (response.provider === "codestream") {
			if (
				currentTeam.providerInfo !== undefined &&
				Object.keys(currentTeam.providerInfo).length > 0
			) {
				// the user is using email/password for a CS team and being put into another type team
				return { error: LoginResult.InvalidCredentials };
			}
		}

		this._providers = currentTeam.providerHosts || {};
		registerProviders(this._providers, this);

		const cc = Logger.getCorrelationContext();

		SessionContainer.initialize(this);
		try {
			// after initializing, wait for the initial search of git repositories to complete,
			// otherwise newly matched repos might be returned to the webview before the bootstrap
			// request can be processed, resulting in bad repo data known by the webview
			// see https://trello.com/c/1IjQLhzh - Colin
			await SessionContainer.instance().git.ensureSearchComplete();
		} catch (e) {
			Logger.error(e, cc);
		}

		// re-register to acknowledge lsp handlers from newly instantiated classes
		registerDecoratedHandlers(this.agent);

		// Make sure to update this after the slack/msteams switch as the userId will change
		this._userId = response.user.id;
		this._email = response.user.email;

		this.setStatus(SessionStatus.SignedIn);

		this.api.onDidReceiveMessage(e => this.onRTMessageReceived(e), this);

		Logger.log(cc, `Subscribing to real-time events...`);
		await this.api.subscribe();

		this._documentEventHandler = new DocumentEventHandler(
			this,
			SessionContainer.instance().session.agent.documents
		);

		SessionContainer.instance().git.onRepositoryCommitHashChanged(repo => {
			this.repositoryCommitHashChanged(repo);
		});

		SessionContainer.instance().git.onRepositoryChanged(data => {
			SessionContainer.instance().session.agent.sendNotification(DidChangeDataNotificationType, {
				type: ChangeDataType.Commits,
				data: data
			});
		});

		SessionContainer.instance().git.onGitWorkspaceChanged(data => {
			SessionContainer.instance().session.agent.sendNotification(DidChangeDataNotificationType, {
				type: ChangeDataType.Workspace,
				data: data
			});
		});

		// this needs to happen before initializing telemetry, because super-properties are dependent
		if (this.apiCapabilities.testGroups) {
			const company = await this.setCompanyTestGroups();
			if (company) {
				// replace company object in the response, so the test groups are correct
				// for telemetry, and also what we send back to the webview
				const index = response.companies.findIndex(c => c.id === company.id);
				response.companies.splice(index, 1);
				response.companies.push(company);
			}
		}

		// Initialize tracking
		this.initializeTelemetry(response.user, currentTeam, response.companies);

		const loginResponse = {
			loginResponse: { ...response },
			state: {
				token: token,
				capabilities: this.api.capabilities,
				email: this._email!,
				environment: this._environment,
				isOnPrem: this._isOnPrem,
				serverUrl: this._options.serverUrl!,
				teamId: this._teamId!,
				userId: response.user.id
			}
		};

		setImmediate(() =>
			this.agent.sendNotification(DidLoginNotificationType, { data: loginResponse })
		);

		if (!response.user.timeZone) {
			const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
			this.api.updateUser({ timeZone });
		}

		return loginResponse;
	}

	@log({
		singleLine: true
	})
	async register(request: RegisterUserRequest) {
		function isCSLoginResponse(r: CSRegisterResponse | CSLoginResponse): r is CSLoginResponse {
			return (r as any).accessToken !== undefined;
		}

		try {
			const response = await (this._api as CodeStreamApiProvider).register(request);

			if (isCSLoginResponse(response)) {
				if (response.teams.length === 0) {
					return { status: LoginResult.NotOnTeam, token: response.accessToken };
				}

				this._teamId = response.teams[0].id;
				return { status: LoginResult.AlreadyConfirmed, token: response.accessToken };
			} else {
				return { status: LoginResult.Success };
			}
		} catch (error) {
			if (error instanceof ServerError) {
				if (error.statusCode !== undefined && error.statusCode >= 400 && error.statusCode < 500) {
					return { status: loginApiErrorMappings[error.info.code] || LoginResult.Unknown };
				}
			}

			Container.instance().errorReporter.reportMessage({
				type: ReportingMessageType.Error,
				message: "Unexpected error during registration",
				source: "agent",
				extra: {
					...error
				}
			});
			throw AgentError.wrap(error, `Registration failed:\n${error.message}`);
		}
	}

	@log({ singleLine: true })
	async confirmRegistration(request: ConfirmRegistrationRequest) {
		try {
			const response = await (this._api as CodeStreamApiProvider).confirmRegistration(request);
			if (response.teams.length === 0) {
				return { status: LoginResult.NotOnTeam, token: response.accessToken };
			}

			this._teamId = response.teams[0].id;
			return { status: LoginResult.Success, token: response.accessToken };
		} catch (error) {
			if (error instanceof ServerError) {
				if (error.statusCode !== undefined && error.statusCode >= 400 && error.statusCode < 500) {
					return { status: loginApiErrorMappings[error.info.code] || LoginResult.Unknown };
				}
			}

			Container.instance().errorReporter.reportMessage({
				type: ReportingMessageType.Error,
				message: "Unexpected error confirming registration",
				source: "agent",
				extra: {
					...error
				}
			});
			throw AgentError.wrap(error, `Registration confirmation failed:\n${error.message}`);
			// }
		}
	}

	@log({ singleLine: true })
	async getInviteInfo(request: GetInviteInfoRequest) {
		try {
			const response = await (this._api as CodeStreamApiProvider).getInviteInfo(request);
			return { status: LoginResult.Success, info: response };
		} catch (error) {
			if (error instanceof ServerError) {
				if (error.statusCode !== undefined && error.statusCode >= 400 && error.statusCode < 500) {
					return { status: loginApiErrorMappings[error.info.code] || LoginResult.Unknown };
				}
			}

			Container.instance().errorReporter.reportMessage({
				type: ReportingMessageType.Error,
				message: "Unexpected error getting invite info",
				source: "agent",
				extra: {
					...error
				}
			});
			throw AgentError.wrap(error, `Get invite info failed:\n${error.message}`);
		}
	}

	@log()
	logout(reason: LogoutReason) {
		this.setStatus(SessionStatus.SignedOut);
		return this.agent.sendNotification(DidLogoutNotificationType, { reason: reason });
	}

	async ready() {
		return this._readyPromise;
	}

	@log()
	async reset() {
		this._onDidRequestReset.fire(undefined);
	}

	@log()
	showErrorMessage<T extends MessageActionItem>(message: string, ...actions: T[]) {
		return this._connection.window.showErrorMessage(message, ...actions);
	}

	@log()
	showInformationMessage<T extends MessageActionItem>(message: string, ...actions: T[]) {
		return this._connection.window.showInformationMessage(message, ...actions);
	}

	@log()
	showWarningMessage<T extends MessageActionItem>(message: string, ...actions: T[]) {
		return this._connection.window.showWarningMessage(message, ...actions);
	}

	// having to determine environment in this way is bad ... but we keep it for two reasons:
	// (1) to maintain compatibility with older api servers (for on-prem installs), before this
	//    information was delivered by the api server ... once all our on-prem installs are
	//    forced to be up to date, we can eliminate that reason
	// (2) upon agent initialization, the error reporter (errorReporter.ts) connects to Sentry,
	//    but only in production ... it needs to know if we are in production before we have
	//    communicated with the server, so that will be determined here
	//
	// In theory, this method should be called for no other reason that those given above.
	private getEnvironmentFromServerUrl(url: string): [environment: string, isOnPrem: boolean] {
		const match = envRegex.exec(url);

		// if no match, then our server is not a CodeStream server, meaning we are on-prem
		if (match == null) return [CodeStreamEnvironment.Unknown, true];

		// localhost translates into local development environment,
		// whether we are on-prem or not comes from separate information
		let [, subdomain, env] = match;
		if (subdomain != null && subdomain.toLowerCase() === "localhost") {
			return [CodeStreamEnvironment.Local, false];
		}

		if (env) {
			// a match of the form <env>-api.codestream.us, like PD and QA
			env = env.toLowerCase();
			return [env.toLowerCase(), false];
		} else if (subdomain) {
			// a match of the form <subdomain>.codestream.us, like OPPR, OPBETA, anything else
			subdomain = subdomain.toLowerCase();
			if (subdomain === "api") {
				return [CodeStreamEnvironment.Production, false];
			} else {
				// the need for this goes away when delivered from the server  
				const isOnPrem = subdomain === "opbeta" || subdomain === "oppr"; 
				return [subdomain.toLowerCase(), isOnPrem];
			}
		} else {
			return [CodeStreamEnvironment.Unknown, false];
		}
	}

	private async initializeTelemetry(user: CSMe, team: CSTeam, companies: CSCompany[]) {
		// Set super props
		this._telemetryData.hasCreatedPost = user.totalPosts > 0;

		const props: { [key: string]: any } = {
			$email: user.email,
			name: user.fullName,
			"Team ID": this._teamId,
			"Join Method": user.joinMethod,
			"Last Invite Type": user.lastInviteType,
			"Plugin Version": this.versionInfo.extension.versionFormatted,
			Endpoint: this.versionInfo.ide.name,
			"Endpoint Detail": this.versionInfo.ide.detail,
			"IDE Version": this.versionInfo.ide.version,
			Deployment: this.isOnPrem ? "OnPrem" : "Cloud"
		};

		if (team != null) {
			const company = companies.find(c => c.id === team.companyId);
			props["Company ID"] = team.companyId;
			props["Team Created Date"] = new Date(team.createdAt!).toISOString();
			props["Team Name"] = team.name;
			if (team.memberIds != null) {
				props["Team Size"] = team.memberIds.length;
			}
			if (company) {
				props["Plan"] = company.plan;
				props["Reporting Group"] = company.reportingGroup;
				props["Company Name"] = company.name;
				props["company"] = {
					id: company.id,
					name: company.name,
					plan: company.plan,
					created_at: new Date(company.createdAt!).toISOString()
				};
				if (company.trialStartDate && company.trialEndDate) {
					props["company"]["trialStart_at"] = new Date(company.trialStartDate).toISOString();
					props["company"]["trialEnd_at"] = new Date(company.trialEndDate).toISOString();
				}
				if (company.testGroups) {
					props["AB Test"] = Object.keys(company.testGroups).map(
						key => `${key}|${company.testGroups![key]}`
					);
				}
			}
		}

		if (user.registeredAt) {
			props.$created = new Date(user.registeredAt).toISOString();
		}

		if (user.lastPostCreatedAt) {
			props["Date of Last Post"] = new Date(user.lastPostCreatedAt).toISOString();
		}

		props["First Session"] =
			!!user.firstSessionStartedAt &&
			user.firstSessionStartedAt <= Date.now() + FIRST_SESSION_TIMEOUT;

		const { telemetry } = Container.instance();
		await telemetry.ready();
		telemetry.identify(this._codestreamUserId!, props);
		telemetry.setSuperProps(props);
		if (user.firstSessionStartedAt !== undefined) {
			telemetry.setFirstSessionProps(user.firstSessionStartedAt, FIRST_SESSION_TIMEOUT);
		}
	}

	@log()
	async updateProviders() {
		const currentTeam = await SessionContainer.instance().teams.getByIdFromCache(this.teamId);
		if (currentTeam) {
			this._providers = currentTeam.providerHosts || {};
			registerProviders(this._providers, this);
			this.agent.sendNotification(DidChangeDataNotificationType, {
				type: ChangeDataType.Providers,
				data: this._providers
			});
		}
	}

	registerApiCapabilities(apiCapabilities: CSApiCapabilities, team?: CSTeam): void {
		const teamSettings = (team && team.settings) || {};
		const teamFeatures = teamSettings.features || {};
		this._apiCapabilities = {};
		for (const key in apiCapabilities) {
			const capability = apiCapabilities[key];
			if (
				(!capability.restricted || teamFeatures[key]) &&
				(!capability.supportedIdes || capability.supportedIdes.includes(this.versionInfo.ide.name))
			) {
				this._apiCapabilities[key] = capability;
			}
		}
	}

	async setCompanyTestGroups() {
		const team = await SessionContainer.instance().teams.getByIdFromCache(this.teamId);
		if (!team) return;
		const company = await SessionContainer.instance().companies.getByIdFromCache(team.companyId);
		if (!company) return;

		// for each test, check if our company has been assigned a group, if not,
		// generate a random group assignment from the possible choices and ping the server
		const set: { [key: string]: string } = {};
		const companyTestGroups = company.testGroups || {};
		for (let testName in testGroups) {
			if (!companyTestGroups[testName]) {
				const { choices } = testGroups[testName];
				const which = Math.floor(Math.random() * choices.length);
				set[testName] = choices[which];
			}
		}

		if (Object.keys(set).length > 0) {
			return this.api.setCompanyTestGroups(company.id, set);
		}
		return undefined;
	}

	private async repositoryCommitHashChanged(repo: GitRepository) {
		const { git, markerLocations, reviews, users } = SessionContainer.instance();
		markerLocations.flushUncommittedLocations(repo);

		const me = await users.getMe();
		if (me.user.preferences?.reviewCreateOnDetectUnreviewedCommits !== false) {
			reviews.checkUnreviewedCommits(repo).then(unreviewedCommitCount => {
				Logger.log(`Detected ${unreviewedCommitCount} unreviewed commits`);
			});
		}

		if (!this.apiCapabilities.autoFR) {
			return;
		}
		const commit = await git.getCommit(repo.path, "HEAD");
		const userEmail = await git.getConfig(repo.path, "user.email");
		const twentySeconds = 20 * 1000;
		if (
			userEmail !== undefined &&
			userEmail === commit?.email &&
			commit.authorDate !== undefined &&
			new Date().getTime() - commit.authorDate.getTime() < twentySeconds
		) {
			this.agent.sendNotification(UserDidCommitNotificationType, {
				sha: commit.ref
			});
		}
	}

	dispose() {
		if (this._documentEventHandler) {
			this._documentEventHandler.dispose();
		}
	}
}
