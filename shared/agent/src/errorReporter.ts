import * as Sentry from "@sentry/node";
import { Severity } from "@sentry/node";
import * as os from "os";
import { ReportSuppressedMessages } from "./agentError";
import { Team } from "./api/extensions";
import { SessionContainer } from "./container";
import {
	CodeStreamEnvironment,
	ReportBreadcrumbRequest,
	ReportBreadcrumbRequestType,
	ReportMessageRequest,
	ReportMessageRequestType
} from "./protocol/agent.protocol";
import { CodeStreamSession, SessionStatus } from "./session";
import { lsp, lspHandler } from "./system";
import { Logger } from "./logger";

@lsp
export class ErrorReporter {
	constructor(session: CodeStreamSession) {
		if (session.environment === CodeStreamEnvironment.Production) {
			Logger.log("Initializing Sentry...");
			Sentry.init({
				dsn: "https://7c34949981cc45848fc4e3548363bb17@sentry.io/1314159",
				release: session.versionInfo.extension.versionFormatted,
				environment: session.environment,
				maxBreadcrumbs: 500,
				maxValueLength: 500
			});

			Sentry.configureScope(scope => {
				scope.setTag("platform", os.platform());
				scope.setTag("ide", session.versionInfo.ide.name);
				scope.setTag("ideDetail", session.versionInfo.ide.detail);
				scope.setExtra("ideVersion", session.versionInfo.ide.version);
				scope.setTag("source", "agent");

				// we purposefully intercept certain errors, and don't send them to Sentry
				// would be better to actually get the original exception here, and not have to rely on the
				// exception message, but sadly, Sentry doesn't seem to give us the original exception
				// for rejects promises
				const suppressMessages = Object.values(ReportSuppressedMessages).map(v => v as string);
				scope.addEventProcessor(event => {
					if (
						event.exception?.values?.find(value => {
							return value.value && suppressMessages.indexOf(value.value) !== -1;
						})
					) {
						return null;
					}
					return event;
				});
			});

			session.onDidChangeSessionStatus(event => {
				if (event.getStatus() === SessionStatus.SignedOut) return;

				Sentry.configureScope(async scope => {
					const team = await SessionContainer.instance().teams.getById(session.teamId);
					//  TODO: acknowledge telemetryConsent
					scope.setUser({
						id: session.userId,
						email: session.email,
						team: {
							id: team.id,
							name: team.name,
							provider: Team.isSlack(team)
								? "Slack"
								: Team.isMSTeams(team)
								? "MSTeams"
								: "CodeStream"
						}
					});
				});
			});
		} else {
			Logger.log("Not initializing Sentry, this is not production");
		}
	}

	@lspHandler(ReportMessageRequestType)
	reportMessage(request: ReportMessageRequest) {
		Sentry.captureEvent({
			level: Severity.fromString(request.type),
			timestamp: Date.now(),
			message: request.message,
			extra: request.extra,
			tags: {
				source: request.source
			}
		});
	}

	@lspHandler(ReportBreadcrumbRequestType)
	reportBreadcrumb(request: ReportBreadcrumbRequest) {
		Sentry.addBreadcrumb({
			message: request.message,
			data: request.data,
			level: request.level ? Severity.fromString(request.level) : undefined,
			category: request.category
		});
	}
}
