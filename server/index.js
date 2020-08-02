import axios from "axios";
import express from "express";
import bodyParser from "body-parser";
import Workflow from "./models/workflow.js";

const {
  ARGO_SERVER_URL,
  ARGO_SERVER_TOKEN,
  GITEA_SERVER_URL,
  GITEA_SERVER_TOKEN,
  PORT,
} = process.env;
const TARGET_PORT = PORT || 1234;
const CI_RUNNING_IMAGE =
  process.env.TESTS_RUNNING_IMAGE ||
  "https://media.giphy.com/media/8WeatsYCC54TC/giphy.gif";
const CI_SUCCEED_IMAGE =
  process.env.TESTS_SUCCEED_IMAGE ||
  "https://media.giphy.com/media/zaqclXyLz3Uoo/giphy.gif";
const CI_FAILED_IMAGE =
  process.env.TESTS_FAILED_IMAGE ||
  "https://media.giphy.com/media/li0dswKqIZNpm/giphy.gif";
const app = express();

app.use(bodyParser.json());

// TODO: create k8s deployment
app.post("/submit-workflow", (req, res) => {
  const workflowTemplate = req.body.secret || "hello-argo";
  const { repository, ref, commits } = req.body;
  const project = repository.full_name;

  if ("commits" in req.body) {
    const branch = ref.replace("refs/heads/", "");
    const targetCommit = commits[commits.length - 1];

    if (targetCommit) {
      console.log(`Git push to existing repo ${project}/${branch}:`);
      return sendWorkflowToArgo(res, {
        workflowTemplate,
        sender: targetCommit.committer.username,
        project,
        branch,
        commitHash: targetCommit.id,
        event: "git-push",
      });
    } else if (isNewBranch(req.body)) {
      console.log(`New branch on ${project}/${branch}:`);
      return sendWorkflowToArgo(res, {
        workflowTemplate,
        sender: req.body.username,
        project,
        branch,
        commitHash: req.body.after,
        event: "new-branch",
      });
    }
  } else if (isNewPullRequest(req.body)) {
    const targetBranch = req.body.pull_request.head.ref;

    console.log(
      `New pull request on ${project}/${targetBranch} -> ${project}/${req.body.pull_request.base.ref}`
    );

    return sendWorkflowToArgo(res, {
      workflowTemplate,
      sender: req.body.username,
      project,
      branch: targetBranch,
      commitHash: req.body.pull_request.head.sha,
      event: "new-pull-request",
      pullRequestNumber: req.body.pull_request.number,
    });
  }

  res.end();
});

app.post("/submit-workflow-result", (req, res) => {
  const foundWorkflow = Workflow.findBy({
    workflowName: req.body.workflowName,
  });

  if (foundWorkflow && foundWorkflow.pullRequestNumber) {
    return postCIResultsToPR(res, foundWorkflow, req.body);
  }

  return res.status(201).end();
});

app.listen(TARGET_PORT, () =>
  console.log(`server listening on ${TARGET_PORT}`)
);

function sendWorkflowToArgo(res, workflowDetails) {
  const {
    workflowTemplate,
    sender,
    project,
    branch,
    commitHash,
    event,
    pullRequestNumber,
  } = workflowDetails;
  const projectLabel = project.replace("/", ".");

  // IN FUTURE: ownerReference to k8s ServiceAccount
  return axios
    .post(
      `${ARGO_SERVER_URL}/api/v1/workflows/argo/submit`,
      {
        resourceKind: "WorkflowTemplate",
        resourceName: workflowTemplate,
        submitOptions: {
          labels:
            `workflows.argoproj.io/workflow-template=${workflowTemplate},workflows.argoproj.io/sender=${sender}` +
            `,workflows.argoproj.io/project=${projectLabel},workflows.argoproj.io/branch=${branch}` +
            `,workflows.argoproj.io/commit-hash=${commitHash},workflows.argoproj.io/event=${event}`,
        },
      },
      {
        headers: {
          Authorization: `Bearer ${ARGO_SERVER_TOKEN}`,
        },
      }
    )
    .then(async (argoResult) => {
      console.log(`Job #${metadata.name} submitted`);

      const metadata = argoResult.data.metadata;
      const workflow = Workflow.insert({
        branch,
        project,
        workflowName: metadata.name,
        status: "Running",
        pullRequestNumber:
          event === "new-pull-request"
            ? pullRequestNumber
            : await getPullRequestNumber(project, branch),
        startAt: metadata.creationTimestamp,
      });

      res.status(201).end();

      return postCIRunningToPR(workflow, argoResult);
    })
    .catch((error) => {
      console.log("Error occured during job submission:");
      console.log(error);

      return res.status(500).end();
    });
}

function isNewBranch(requestBody) {
  return requestBody.before === "0000000000000000000000000000000000000000";
}

function isNewPullRequest(requestBody) {
  return requestBody.action === "opened" && requestBody.pull_request;
}

function postCIRunningToPR(workflow, argoResult) {
  const { project, branch, pullRequestNumber, workflowName } = workflow;
  const message =
    `Tests running on ${ARGO_SERVER_URL}/workflows/argo/${workflowName} \n\n` +
    `![Tests running](${CI_RUNNING_IMAGE});`;

  return axios
    .post(
      `${GITEA_SERVER_URL}/api/v1/repos/${project}/issues/${pullRequestNumber}/comments`,
      {
        body: message,
      },
      {
        headers: {
          Authorization: `token ${GITEA_SERVER_TOKEN}`,
        },
      }
    )
    .then((result) => {
      console.log(
        `CI Running comment posted on ${project}/${branch} PR#${pullRequestNumber}`
      );
    })
    .catch((error) => {
      console.log(
        `Error occured during posting CI running comment to PR#${pullRequestNumber}`
      );
      console.log(error);
    });
}

function postCIResultsToPR(res, workflow, requestBody) {
  const message =
    requestBody.workflowStatus === "Succeeded"
      ? `Tests succeeded on ${ARGO_SERVER_URL}/workflows/argo/${requestBody.workflowName} \n\n` +
        `![Tests running](${CI_SUCCEED_IMAGE});`
      : `Tests failed on ${ARGO_SERVER_URL}/workflows/argo/${requestBody.workflowName} \n\n` +
        `![Tests running](${CI_FAILED_IMAGE});`;

  return axios
    .post(
      `${GITEA_SERVER_URL}/api/v1/repos/${workflow.project}/issues/${workflow.pullRequestNumber}/comments`,
      {
        body: message,
      },
      {
        headers: {
          Authorization: `token ${GITEA_SERVER_TOKEN}`,
        },
      }
    )
    .then((result) => {
      console.log(
        `CI Result comment posted on ${workflow.project}/${workflow.branch} PR#${workflow.pullRequestNumber}`
      );

      return res.status(201).end();
    })
    .catch((error) => {
      console.log(
        `Error occured during posting CI result comment to PR#${workflow.pullRequestNumber}`
      );
      console.log(error);

      return res.status(500).end();
    });
}

async function getPullRequestNumber(project, branch) {
  const { status, data } = await axios.get(
    `${GITEA_SERVER_URL}/api/v1/repos/${project}/pulls?state=open`,
    {
      headers: {
        Authorization: `token ${GITEA_SERVER_URL}`,
      },
    }
  );

  if (status === 200) {
    const targetPullRequest = data.find(
      (pullRequest) => pullRequest.head.ref === branch
    );

    return targetPullRequest && targetPullRequest.number;
  }
}
