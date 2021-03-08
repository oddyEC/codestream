import React, { useState } from "react";
import Icon from "../../Icon";
import { MarkdownText } from "../../MarkdownText";
import { PullRequestReplyComment } from "../../PullRequestReplyComment";
import Tag from "../../Tag";
import Timestamp from "../../Timestamp";
import Tooltip from "../../Tooltip";
import { ActionBox, OutlineBox } from "./PullRequest";
import {
	FetchThirdPartyPullRequestPullRequest,
	GitLabMergeRequest
} from "@codestream/protocols/agent";
import { PRHeadshot } from "@codestream/webview/src/components/Headshot";
import styled from "styled-components";
import { PullRequestCommentMenu } from "../../PullRequestCommentMenu";
import { PRActionIcons, PRCodeCommentReplyInput } from "../../PullRequestComponents";
import { PRAuthorBadges } from "../../PullRequestConversationTab";
import { Link } from "../../Link";
import { PullRequestEditingComment } from "../../PullRequestEditingComment";
import { PullRequestReactButton, PullRequestReactions } from "./PullRequestReactions";
import { Button } from "@codestream/webview/src/components/Button";
import { PullRequestPatch } from "../../PullRequestPatch";
import copy from "copy-to-clipboard";

const BigRoundImg = styled.span`
	img {
		border-radius: 50%;
		margin: 0px 15px 0px 0px;
		vertical-align: middle;
		height: 30px;
	}
`;

const ReplyForm = styled.div`
	background: var(--base-background-color);
	border-top: 1px solid var(--base-border-color);
	border-radius: 0 0 4px 4px;
	margin: 10px -10px -10px -10px;
	padding: 10px 10px 10px 10px;
	display: flex;
	button {
		margin-left: 10px;
		flex-grow: 0;
	}
	${PRHeadshot} {
		position: absolute;
		left: 0;
		top: 0;
	}
	${PullRequestReplyComment} {
		flex-grow: 1;
	}
	${PRCodeCommentReplyInput} {
		border-radius: 4px;
	}
`;

const Collapse = styled.div`
	background: var(--base-background-color);
	border-top: 1px solid var(--base-border-color);
	border-bottom: 1px solid var(--base-border-color);
	padding: 10px;
	margin: 10px -10px;
	cursor: pointer;
	&:hover {
		background: var(--app-background-color-hover);
	}
	&.collapsed {
		margin: 10px -10px -10px -10px;
		border-bottom: none;
		border-radius: 0 0 4px 4px;
	}
`;

export const OutlineBoxHeader = styled.div`
	display: flex;
	flex-wrap: wrap;
	align-items: top;
	border-radius: 4px 4px 0 0;
	padding-left: 40px;
	position: relative;
	${BigRoundImg} {
		position: absolute;
		left: 0;
		top: 0;
	}
`;

const ToggleThread = styled.span`
	cursor: pointer;
`;

const Comment = styled.div`
	position: relative;
	&.nth-reply {
		padding-top: 15px;
	}
`;

const CodeCommentPatch = styled.div`
	margin: -10px -10px 15px -10px;
	border-bottom: 1px solid var(--base-border-color);
	.codemark.inline & {
		margin 10px 0;
		border: 1px solid var(--base-border-color);
	}
	.pr-patch {
		border: none;
	}
`;

const CommentBody = styled.div`
	padding: 5px 0 5px 40px;
`;

let insertText;
let insertNewline;
let focusOnMessageInput;

interface Props {
	pr: GitLabMergeRequest;
	filter: "history" | "comments" | "all";
	order: "oldest" | "newest";
	setIsLoadingMessage: Function;
}

const EMPTY_HASH = {};
const EMPTY_HASH_1 = {};
const EMPTY_HASH_2 = {};
const EMPTY_HASH_3 = {};

export const Timeline = (props: Props) => {
	const { pr, order, filter, setIsLoadingMessage } = props;
	let discussions = order === "oldest" ? pr.discussions.nodes : [...pr.discussions.nodes].reverse();
	if (filter === "history") discussions = discussions.filter(_ => !isComment(_));
	else if (filter === "comments") discussions = discussions.filter(_ => isComment(_));

	const iconMap = {
		user: "person",
		"pencil-square": "pencil",
		commit: "git-commit",
		"lock-open": "unlock",
		lock: "lock",
		timer: "clock",
		unapproval: "x",
		approval: "check",
		fork: "git-branch"
	};

	const __onDidRender = functions => {
		insertText = functions.insertTextAtCursor;
		insertNewline = functions.insertNewlineAtCursor;
		focusOnMessageInput = functions.focus;
	};

	const isComment = _ => _.notes && _.notes.nodes && _.notes.nodes.length;

	const quote = text => {
		if (!insertText) return;
		focusOnMessageInput &&
			focusOnMessageInput(() => {
				insertText && insertText(text.replace(/^/gm, "> "));
				insertNewline && insertNewline();
			});
	};

	const [editingComments, setEditingComments] = useState(EMPTY_HASH_1);
	const [pendingComments, setPendingComments] = useState(EMPTY_HASH_2);
	const [hiddenComments, setHiddenComments] = useState(EMPTY_HASH_3);

	const doneEditingComment = id => {
		setEditingComments({ ...editingComments, [id]: false });
	};

	const setEditingComment = (comment, value) => {
		setEditingComments({
			...editingComments,
			[comment.id]: value
		});
		setPendingComments({
			...pendingComments,
			[comment.id]: value ? comment.body : ""
		});
	};

	const printCodeCommentHeader = note => {
		return (
			<>
				<OutlineBoxHeader style={{ flexWrap: "nowrap" }}>
					{note.author && (
						<div style={{ flexGrow: 1 }}>
							<Tooltip title={<pre className="stringify">{JSON.stringify(note, null, 2)}</pre>}>
								<BigRoundImg>
									<img style={{ float: "left" }} alt="headshot" src={note.author.avatarUrl} />
								</BigRoundImg>
							</Tooltip>
							<div>
								<b>{note.author.name}</b> @{note.author.login} started a thread on the diff
								<Timestamp relative time={note.createdAt} />
								<br />
								Last updated <Timestamp relative time={note.updatedAt} />
							</div>
						</div>
					)}

					<PRActionIcons>
						<ToggleThread
							onClick={() => {
								setHiddenComments({ ...hiddenComments, [note.id]: !hiddenComments[note.id] });
							}}
						>
							<Icon name={hiddenComments[note.id] ? "chevron-down-thin" : "chevron-up-thin"} />{" "}
							Toggle thread
						</ToggleThread>
					</PRActionIcons>
				</OutlineBoxHeader>
				{!hiddenComments[note.id] && (
					<>
						<Collapse>
							<Icon name="file" /> {note.position.newPath}{" "}
							<Icon
								name="copy"
								onClick={() => copy(note.position.newPath)}
								title="Copy file path"
								placement="top"
							/>
						</Collapse>
						<CodeCommentPatch>
							<PullRequestPatch
								patch={
									'@@ -13,11 +13,17 @@ import {\n     FIXME THIS IS HARDCODED\n import { PRHeadshot } from "@codestream/webview/src/components/Headshot";\n import styled from "styled-components";\n import { PullRequestCommentMenu } from "../../PullRequestCommentMenu";\n-import { PRActionIcons, PRCommentHeader } from "../../PullRequestComponents";\n+import {\n+       PRActionIcons,\n+       PRCodeCommentPatch,\n+       PRCodeCommentReplyInput\n'
								}
								filename={note.position.newPath}
								truncateLargePatches
							/>
						</CodeCommentPatch>
					</>
				)}
			</>
		);
	};

	const printComment = (note, index, isResolvable?: boolean) => {
		return (
			<Comment className={index === 0 ? "first-reply" : "nth-reply"}>
				<OutlineBoxHeader>
					{note.author && (
						<Tooltip title={<pre className="stringify">{JSON.stringify(note, null, 2)}</pre>}>
							<BigRoundImg>
								<img style={{ float: "left" }} alt="headshot" src={note.author.avatarUrl} />
							</BigRoundImg>
						</Tooltip>
					)}
					{note.author && (
						<div style={{ flexGrow: 1 }}>
							<div>
								<b>{note.author.name}</b> @{note.author.login} &middot;{" "}
								<Timestamp relative time={note.createdAt} />
							</div>
						</div>
					)}
					{!note.author && <pre className="stringify">{JSON.stringify(note, null, 2)}</pre>}

					<PRActionIcons>
						<PRAuthorBadges
							pr={(pr as unknown) as FetchThirdPartyPullRequestPullRequest}
							node={note}
							isPending={note.state === "PENDING"}
						/>
						{isResolvable && (
							<Icon
								name="check-circle"
								className="clickable"
								title="Resolve thread"
								placement="bottom"
							/>
						)}
						<PullRequestReactButton
							pr={pr}
							targetId={note.id}
							setIsLoadingMessage={setIsLoadingMessage}
							reactionGroups={note.reactionGroups}
						/>

						<PullRequestCommentMenu
							pr={pr}
							fetch={fetch}
							setIsLoadingMessage={setIsLoadingMessage}
							node={note}
							nodeType="REVIEW"
							viewerCanDelete={note.viewerCanDelete && note.state === "PENDING"}
							setEdit={setEditingComment}
							quote={quote}
							isPending={note.state === "PENDING"}
						/>
					</PRActionIcons>
				</OutlineBoxHeader>

				<CommentBody>
					{editingComments[note.id] ? (
						<PullRequestEditingComment
							pr={pr}
							setIsLoadingMessage={setIsLoadingMessage}
							id={note.id}
							type={"ISSUE"}
							text={pendingComments[note.id]}
							done={() => doneEditingComment(note.id)}
						/>
					) : (
						<>
							<MarkdownText text={note.body} />
							<PullRequestReactions
								pr={pr}
								targetId={note.id}
								setIsLoadingMessage={setIsLoadingMessage}
								reactionGroups={note.reactionGroups}
							/>
						</>
					)}
				</CommentBody>
			</Comment>
		);
	};

	const repliesSummary = replies => {
		const lastReply = replies[replies.length - 1];
		return (
			<>
				<Link>{replies.length === 1 ? "1 reply" : `${replies.length} replies`}</Link>
				{lastReply.author && (
					<>
						{" "}
						Last reply by {lastReply.author.name || lastReply.author.login}{" "}
						<Timestamp relative time={lastReply.createdAt} />
					</>
				)}
			</>
		);
	};

	const printNote = note => {
		if (note.system) {
			return (
				<ActionBox>
					<Icon
						name={iconMap[note.systemNoteIconName] || "blank"}
						className="circled"
						title={<pre className="stringify">{JSON.stringify(note, null, 2)}</pre>}
					/>
					<div>
						<b>{note.author.name}</b> @{note.author.login} <MarkdownText inline text={note.body} />
						<Timestamp relative time={note.createdAt} />
					</div>
				</ActionBox>
			);
		}

		// if it's a review thread, and the thread is collapsed, just
		// render the header
		if (note.position && hiddenComments[note.id])
			return <OutlineBox style={{ padding: "10px" }}>{printCodeCommentHeader(note)}</OutlineBox>;

		const replies = note.replies || [];
		return (
			<OutlineBox style={{ padding: "10px" }}>
				{note.position && printCodeCommentHeader(note)}
				{printComment(note, 0, note.resolvable)}
				{note.resolvable && (
					<>
						{replies.length > 0 && !note.position && (
							<Collapse
								className={hiddenComments[note.id] ? "collapsed" : ""}
								onClick={() => {
									setHiddenComments({ ...hiddenComments, [note.id]: !hiddenComments[note.id] });
								}}
							>
								<Icon name={hiddenComments[note.id] ? "chevron-right-thin" : "chevron-down-thin"} />{" "}
								{hiddenComments[note.id] ? repliesSummary(replies) : "Collapse replies"}
							</Collapse>
						)}
						{!hiddenComments[note.id] &&
							replies.map((reply, index) => printComment(reply, index + 1))}
						{!hiddenComments[note.id] && (
							<ReplyForm>
								<PullRequestReplyComment
									pr={(pr as unknown) as FetchThirdPartyPullRequestPullRequest}
									mode={note}
									fetch={fetch}
									databaseId={note.id}
									isOpen={false}
									__onDidRender={__onDidRender}
								/>
								<Button variant="secondary" onClick={() => {}}>
									Resolve<span className="wide-text"> thread</span>
								</Button>
							</ReplyForm>
						)}
					</>
				)}
			</OutlineBox>
		);
	};

	return (
		<>
			{discussions.map((_: any, index: number) => {
				if (_.type === "merge-request") {
					if (_.action === "opened") {
						return (
							<ActionBox key={index}>
								<Icon
									name="reopen"
									className="circled"
									title={<pre className="stringify">{JSON.stringify(_, null, 2)}</pre>}
								/>
								<div>
									<b>{_.author.name}</b> @{_.author.login} reopened
									<Timestamp relative time={_.createdAt} />
								</div>
							</ActionBox>
						);
					} else if (_.action === "closed") {
						return (
							<ActionBox key={index}>
								<Icon
									name="minus-circle"
									className="circled"
									title={<pre className="stringify">{JSON.stringify(_, null, 2)}</pre>}
								/>
								<div>
									<b>{_.author.name}</b> @{_.author.login} closed
									<Timestamp relative time={_.createdAt} />
								</div>
							</ActionBox>
						);
					} else if (_.action === "approved") {
						return (
							<ActionBox key={index}>
								<Icon
									name="check"
									className="circled"
									title={<pre className="stringify">{JSON.stringify(_, null, 2)}</pre>}
								/>
								<div>
									<b>{_.author.name}</b> @{_.author.login} approved this merge request
									<Timestamp relative time={_.createdAt} />
								</div>
							</ActionBox>
						);
					} else if (_.action === "unapproved") {
						return (
							<ActionBox key={index}>
								<Icon
									name="minus-circle"
									className="circled"
									title={<pre className="stringify">{JSON.stringify(_, null, 2)}</pre>}
								/>
								<div>
									<b>{_.author.name}</b> @{_.author.login} unapproved this merge request
									<Timestamp relative time={_.createdAt} />
								</div>
							</ActionBox>
						);
					}
					return (
						<div>
							unknown merge-request node:
							<br />
							<pre className="stringify">{JSON.stringify(_, null, 2)}</pre>
							<br />
							<br />
						</div>
					);
				} else if (_.type === "milestone") {
					if (_.action === "removed")
						return (
							<ActionBox key={index}>
								<Icon
									name="clock"
									className="circled"
									title={<pre className="stringify">{JSON.stringify(_, null, 2)}</pre>}
								/>
								<div>
									<b>{_.author.name}</b> @{_.author.login} removed milestone{" "}
									<Timestamp relative time={_.createdAt} />
								</div>
							</ActionBox>
						);
					else
						return (
							<ActionBox key={index}>
								<Icon
									name="clock"
									className="circled"
									title={<pre className="stringify">{JSON.stringify(_, null, 2)}</pre>}
								/>
								<div>
									<b>{_.author.name}</b> @{_.author.login} changed milestone{" "}
									<Timestamp relative time={_.createdAt} />
								</div>
							</ActionBox>
						);
				} else if (_.type === "label") {
					if (_.action === "removed")
						return (
							<ActionBox key={index}>
								<Icon
									name="tag"
									className="circled"
									title={<pre className="stringify">{JSON.stringify(_, null, 2)}</pre>}
								/>
								<div>
									<b>{_.author.name}</b> @{_.author.login} removed label{" "}
									<Tag tag={{ label: _.label.name, color: `${_.label.color}` }} />
									<Timestamp relative time={_.createdAt} />
								</div>
							</ActionBox>
						);
					else
						return (
							<ActionBox key={index}>
								<Icon
									name="tag"
									className="circled"
									title={<pre className="stringify">{JSON.stringify(_, null, 2)}</pre>}
								/>
								<div>
									<b>{_.author.name}</b> @{_.author.login} added label{" "}
									<Tag tag={{ label: _.label.name, color: `${_.label.color}` }} />
									<Timestamp relative time={_.createdAt} />
								</div>
							</ActionBox>
						);
				} else if (_.notes && _.notes.nodes && _.notes.nodes.length > 0) {
					return (
						<>
							{/* <pre className="stringify">{JSON.stringify(_, null, 2)}</pre> */}
							{_.notes.nodes.map(note => printNote(note))}
						</>
					);
				} else {
					// console.warn("why here?", _);
					return printNote(_);
				}
			})}
		</>
	);
};