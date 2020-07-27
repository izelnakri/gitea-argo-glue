### Design doc

https://git.izelnakri.com - Gitea server that hosts the code

each push calls a webhook to ->

POST https://glue.izelnakri.com/submit-workflow

this pushes to:

POST https://argo.izelnakri.com [with workflow ns/name, server-token and git repo and branch label]

when argo finishes the workflow:

sends details to ->

POST https://glue.izelnakri.com/notifications

this sends an email to ```ADMIN_EMAIL and commit owner email```

argo CI when passes creates a hashed container on harbor registry(https://registry.izelnakri.com).

pushes the commit to https://git.izelnakri.com and finalizes the workflow and runs argo cd webhook, makes a request to:

https://cd.izelnakri.coma

ArgoCD keeps a history of releases for rollback, auditing and deployment in GitOps way.

#### ENV variables

```
$HOST_NAME, $ARGO_SERVER, $ARGO_SERVER_TOKEN, $WORKFLOW_NAME, $WORKFLOW_NAMESPACE, $ADMIN_EMAIL
```
