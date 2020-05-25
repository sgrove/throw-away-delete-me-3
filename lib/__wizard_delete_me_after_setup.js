import Container from '../components/container'
import MoreStories from '../components/more-stories'
import HeroPost from '../components/hero-post'
import Intro from '../components/intro'
import Alert from '../components/alert'
import Footer from '../components/footer'
import Meta from '../components/meta'
import Head from 'next/head'
import {
  ONE_GRAPH_APP_ID,
  AUTO_DETECTED_GITHUB_LINK,
  GIT_CHECKOUT_LINK,
  FEEDBACK_REPO_ID,
  ONE_GRAPH_SERVER_SIDE_ACCESS_TOKEN,
} from '../lib/constants'
import {
  auth,
  destroyAuth,
  saveAuth,
  useAuthGuardian,
  useFetchSupportedServices,
  fetchOneGraph,
} from '../lib/oneGraphNextClient'
import { isSsr } from './common'
import { corsPrompt } from '../lib/metaHelpers'
import MultiStep from 'react-multistep'
import OneGraphAuth from 'onegraph-auth'
import { SubscriptionClient } from 'onegraph-subscription-client'

async function asyncForEach(array, callback) {
  for (let index = 0; index < array.length; index++) {
    await callback(array[index], index, array)
  }
}

const vercelOperationDoc = `
query FindMeOnVercel {
  me {
    vercel: zeit {
      id
      email
      name
      username
      avatar
    }
  }
}

query VercelProjectByNameQuery($projectName: String!) {
  vercel: zeit {
    secrets {
      uid
      name
      created
    }
    projectByName(name: $projectName) {
      ...ZeitProjectFullFragment
    }
  }
}

query VercelProjectByIdQuery($projectId: String!) {
  vercel: zeit {
    secrets {
      uid
      name
      created
    }
    projectById(id: $projectId) {
      ...ZeitProjectFullFragment
    }
  }
}

mutation TriggerRedeployMutation(
  $projectId: String!
) {
  vercel: zeit {
    triggerProjectRedeployment(
      input: { projectId: $projectId }
    ) {
      project {
        ...ZeitProjectFullFragment
      }
    }
  }
}

mutation CreateSecretMutation(
  $name: String!
  $value: String!
) {
  vercel: zeit {
    createSecret(input: { name: $name, value: $value }) {
      secret {
        created
        name
        uid
      }
    }
  }
}

mutation SetEnvironmentalVariableMutation(
  $projectId: String!
  $key: String!
  $secretId: String!
) {
  vercel: zeit {
    createEnvironmentalVariable(
      input: {
        projectId: $projectId
        key: $key
        secretId: $secretId
      }
    ) {
      environmentalVariable {
        configurationId
        createdAt
        key
        target
        updatedAt
        value
      }
    }
  }
}

subscription DeploymentCreatedSubscription(
  $projectId: String!
) {
  vercel: zeit {
    deploymentCreatedEvent(
      input: { projectId: $projectId }
    ) {
      raw
    }
  }
}

subscription DeploymentReadySubscription(
  $projectId: String!
) {
  vercel: zeit {
    deploymentReadyEvent(input: { projectId: $projectId }) {
      raw
    }
  }
}

subscription LogSubscription($projectId: String!) {
  vercel: zeit {
    logEvent(input: { projectId: $projectId }) {
      raw
    }
  }
}

fragment ZeitProjectFullFragment on ZeitProjectFull {
  id
  name
  updatedAt
  createdAt
  accountId
  alias {
    uid
    alias
    created
    createdAt
    updatedAt
    deploymentId
    projectId
  }
  latestDeployments {
    uid
    url
  }
  env {
    configurationId
    createdAt
    key
    target
    updatedAt
    value
  }
}`

/** Our first-setup wizard has to do the following steps:
0. Display the inferred project name
1. Try to get the project id based on name
2. Check to see if ONE_GRAPH_APP_ID is set via ENV. If not, check in the project env list via api (in case the user refreshed the page before redeploying)
2a. Handle CORS prompt here so we can make our calls
3. If it's not set in env or the API, render a link asking them to go to their OG dashboard and copy/paste it in (with example picture) [SERVER=DONE]
4. Create a secret for ONE_GRAPH_APP_ID
5. Set the env var 
6. Repeat 2-5 for SERVER_SIDE_AUTH_TOKEN env var for GitHub access
7. Once all the env vars are set, create a deploy hook url 
8. Hit the deploy-hook url from the browser
9. Show progress bar for new deploy
10. Refresh the page once the deploy is done, app will now be configured and run like normal
*/

// Vercel doesn't give us the project name or id as a build variable, so we have to try to infer it based on the url for the first deploy
const guessVercelProjectName = (windowLocationHostname) => {
  if (isSsr) {
    return null
  }
  const pieces = windowLocationHostname.match(
    '^([a-zA-Z0-9-]+).[a-zA-Z0-9-_]*?.?now.sh'
  )
  console.log('Pieces:', pieces)
  return (pieces || [])[1]
}
const uuidV4Regex = new RegExp(
  /^[A-F\d]{8}-[A-F\d]{4}-4[A-F\d]{3}-[89AB][A-F\d]{3}-[A-F\d]{12}$/i
)

const isValidUUID = (string) => {
  return uuidV4Regex.test(string)
}

const StepSetOneGraphAppId = ({ oneGraphAppId, setOneGraphAppId }) => {
  const errorMessage = isValidUUID(oneGraphAppId)
    ? null
    : 'OneGraph appId should be a valid UUID.'

  return (
    <>
      First, we need your OneGraph app id. You can get one to copy/paste from
      the{' '}
      <a target="_blank" href="https://www.onegraph.com/dashboard">
        OneGraph app dashboard
      </a>
      .
      <img src="onegraph_app_id_preview.png" />
      <br />
      Once you have it, you can enter it here:
      <input
        type="text"
        className="card"
        placeholder="OneGraph appId"
        defaultValue={oneGraphAppId || ''}
        onChange={(event) => {
          const value = event.target.value
          setOneGraphAppId(value)
        }}
      />
    </>
  )
}

const StepSetCorsOrigin = ({
  oneGraphAppId,
  inferredVercelProjectName,
  onCorsConfiguredSuccess,
}) => {
  return (
    <CorsCheck
      oneGraphAppId={oneGraphAppId}
      inferredVercelProjectName={inferredVercelProjectName}
      onCorsConfiguredSuccess={onCorsConfiguredSuccess}
    />
  )
}

const StepSetServerSideAuthToken = () => {
  return (
    <div>
      {' '}
      <img src="onegraph_app_id_preview.png" />
    </div>
  )
}

const StepTriggerDeploy = ({
  vercelUser,
  onLoggedIntoVercel,
  oneGraphAuth,
  vercelProjectId,
  inferredVercelProjectName,
  oneGraphSubscriptClient,
  oneGraphServerSideAccessToken,
}) => {
  const [state, setState] = React.useState({
    vercelProject: null,
    secrets: [],
    actionName: null,
    projectLogs: '',
  })

  const addLogLines = (lines) => {
    setState((oldState) => {
      return {
        ...oldState,
        projectLogs: lines + '\n' + oldState.projectLogs,
      }
    })
  }

  const appIdIsSet = oneGraphAuth && oneGraphAuth.appId

  const refreshProject = async () => {
    if (!appIdIsSet) {
      return
    }

    const result = await fetchOneGraph(
      oneGraphAuth,
      vercelOperationDoc,
      { projectId: vercelProjectId },
      'VercelProjectByIdQuery'
    )
    const secrets = result?.data?.vercel?.secrets
    const vercelProject = result?.data?.vercel?.projectById

    setState((oldState) => {
      return { ...oldState, vercelProject: vercelProject, secrets: secrets }
    })

    return { vercelProject: vercelProject, secrets: secrets }
  }

  React.useEffect(() => {
    refreshProject()
  }, [vercelProjectId, oneGraphAuth && oneGraphAuth.appId])

  const setAppIdPrompt = 'You must first set the OneGraph appId in step 1'

  const loginPrompt = (
    <>
      As the last step, log into Vercel so we can set the environmental
      variables and trigger a new deploy.
      <br />
      <button
        onClick={async () => {
          console.log('PreAuth: ', oneGraphAuth, oneGraphAuth.accessToken())

          await oneGraphAuth.login('zeit')
          console.log('Done!')
          const isLoggedIn = await oneGraphAuth.isLoggedIn('zeit')
          console.log('Is logged in? ', isLoggedIn)
          if (isLoggedIn) {
            saveAuth(auth)
            onLoggedIntoVercel()
          }
        }}
      >
        Log in
      </button>
    </>
  )

  const fullSecretName = (envVarName) => {
    return `${(inferredVercelProjectName || '')
      .toLocaleLowerCase()
      .replace(/\W+/g, '_')}.${envVarName
      .toLocaleLowerCase()
      .replace(/\W+/g, '_')}`
  }

  const findSecretByName = (secrets, envVarName) => {
    const secretName = fullSecretName(envVarName)
    window.sstate = state
    return secrets.find((secret) => secret.name == secretName)
  }

  const findEnvVarByName = (project, envVarName) => {
    return project.env.find((env) => env.key == envVarName)
  }

  const actions = !!state.vercelProject
    ? [
        {
          name: 'Create secrets',
          execute: async (state) => {
            console.log('Creating secret: ', 'ONE_GRAPH_APP_ID')
            await fetchOneGraph(
              oneGraphAuth,
              vercelOperationDoc,
              {
                name: fullSecretName('ONE_GRAPH_APP_ID'),
                value: oneGraphAuth.appId,
              },
              'CreateSecretMutation'
            )

            console.log(
              'Creating secret: ',
              'ONE_GRAPH_SERVER_SIDE_ACCESS_TOKEN'
            )
            await fetchOneGraph(
              oneGraphAuth,
              vercelOperationDoc,
              {
                name: fullSecretName('ONE_GRAPH_SERVER_SIDE_ACCESS_TOKEN'),
                value: oneGraphServerSideAccessToken,
              },
              'CreateSecretMutation'
            )

            console.log('Refreshing project...')
          },
          finishedP: (state) => {
            return (
              !!findSecretByName(state.secrets, 'ONE_GRAPH_APP_ID') &&
              !!findSecretByName(
                state.secrets,
                'ONE_GRAPH_SERVER_SIDE_ACCESS_TOKEN'
              )
            )
          },
        },
        {
          name: 'Create environmental variables',
          execute: async (state) => {
            let secret = findSecretByName(state.secrets, 'ONE_GRAPH_APP_ID')
            console.log('Secret 1: ', secret)

            let secretId = secret.uid
            await fetchOneGraph(
              oneGraphAuth,
              vercelOperationDoc,
              {
                projectId: state.vercelProject.id,
                key: 'ONE_GRAPH_APP_ID',
                secretId: secretId,
              },
              'SetEnvironmentalVariableMutation'
            )

            secret = findSecretByName(
              state.secrets,
              'ONE_GRAPH_SERVER_SIDE_ACCESS_TOKEN'
            )
            console.log('Secret 2: ', secret)

            secretId = secret.uid

            await fetchOneGraph(
              oneGraphAuth,
              vercelOperationDoc,
              {
                projectId: state.vercelProject.id,
                key: 'ONE_GRAPH_SERVER_SIDE_ACCESS_TOKEN',
                secretId: secretId,
              },
              'SetEnvironmentalVariableMutation'
            )
          },
          finishedP: () => {
            return (
              !!findEnvVarByName(state.vercelProject, 'ONE_GRAPH_APP_ID') &&
              !!findEnvVarByName(
                state.vercelProject,
                'ONE_GRAPH_SERVER_SIDE_ACCESS_TOKEN'
              )
            )
          },
        },
        {
          name: 'Trigger redeploy',
          execute: async (state) => {
            oneGraphSubscriptClient
              .request({
                query: vercelOperationDoc,
                variables: { projectId: state.vercelProject.id },
                operationName: 'DeploymentCreatedSubscription',
              })
              .subscribe(
                (next) => {
                  const deploymentId =
                    next.data?.vercel?.deploymentCreatedEvent?.raw?.payload
                      ?.deployment?.id
                  const ownerId =
                    next.data?.vercel?.deploymentCreatedEvent?.raw?.ownerId
                  const region =
                    next.data?.vercel?.deploymentCreatedEvent?.raw?.region

                  const logLine = `Deploy ${deploymentId} started for owner ${ownerId} to region "${region}"`

                  addLogLines(logLine)
                },
                (error) => console.error(error),
                () => console.log('done')
              )

            oneGraphSubscriptClient
              .request({
                query: vercelOperationDoc,
                variables: { projectId: state.vercelProject.id },
                operationName: 'DeploymentReadySubscription',
              })
              .subscribe(
                (next) => {
                  const deploymentId =
                    next.data?.vercel?.deploymentReadyEvent?.raw?.payload
                      ?.deployment?.id

                  const logLine = `Deploy ${deploymentId} finished - refresh to enter the AuthGuardian starterkit!"`
                  addLogLines(logLine)
                  setTimeout(() => window.location.reload(), 3000)
                },
                (error) => console.error(error),
                () => console.log('done')
              )

            oneGraphSubscriptClient
              .request({
                query: vercelOperationDoc,
                variables: { projectId: state.vercelProject.id },
                operationName: 'LogSubscription',
              })
              .subscribe(
                (next) => {
                  const logStatements = next.data?.vercel?.logEvent?.raw || []
                  let relevantLogs = logStatements
                    .filter((statement) => {
                      return (
                        statement.projectId === state.vercelProject.id &&
                        ['stdout'].indexOf(statement.type) > -1
                      )
                    })
                    .map((statement) => statement.message)
                    .reverse()
                    .join('\n')

                  addLogLines(relevantLogs)
                },
                (error) => console.error(error),
                () => console.log('done')
              )

            await fetchOneGraph(
              oneGraphAuth,
              vercelOperationDoc,
              { projectId: state.vercelProject.id },
              'TriggerRedeployMutation'
            )

            setState((oldState) => {
              return {
                ...oldState,
                projectLogs: 'Triggered redeploy, waiting for logs...',
              }
            })

            await refreshProject(state.vercelProject)
          },
          finishedP: (state) => {
            return false
          },
        },
      ]
    : null

  const commitPrompt = !!actions && (
    <>
      You're logged in and ready to go!
      <table>
        <thead>
          <tr>
            <th>Status</th>
            <th>Action</th>
          </tr>
        </thead>
        <tbody>
          {actions.map((action) => {
            const isExecuting = state.actionName === action.name
            return (
              <tr key={action.name}>
                <td className={isExecuting ? 'animate-flicker' : ''}>
                  {isExecuting ? '◌' : action.finishedP(state) ? '⚫' : '◯'}
                </td>
                <td>{action.name}</td>
              </tr>
            )
          })}
        </tbody>
      </table>
      <button
        onClick={async () => {
          await asyncForEach(actions, async (action) => {
            console.log('Execute action: ', action)
            setState((oldState) => {
              return { ...oldState, actionName: action.name }
            })
            const actionState = await refreshProject()
            console.log('Project for ', action.name, actionState)
            await action.execute(actionState)
          })
          console.log('Done')
        }}
      >
        Make it so
      </button>
    </>
  )
  return (
    <div>
      {!appIdIsSet ? setAppIdPrompt : !vercelUser ? loginPrompt : commitPrompt}
      <br />
      {state.actionName === 'Trigger redeploy' ? (
        <div className="card">
          <h1> > Logs</h1>
          <textarea
            className="card"
            style={{ userSelect: 'all' }}
            rows={10}
            value={state.projectLogs}
            readOnly={true}
          ></textarea>
        </div>
      ) : null}
      <br /> <hr />
      Step State:{' '}
      <pre>
        <code>{JSON.stringify(state, null, 2)}</code>
      </pre>
    </div>
  )
}

function CorsCheck({
  oneGraphAppId,
  inferredVercelProjectName,
  onCorsConfiguredSuccess,
  oneGraphAuth,
}) {
  if (isSsr) {
    return 'Loading...'
  }

  const {
    missingOneGraphAppId,
    corsConfigurationRequired,
    loading,
    supportedServices,
  } = useFetchSupportedServices(oneGraphAuth)

  const supportedServicesCount = (supportedServices || []).length

  React.useEffect(() => {
    if (!corsConfigurationRequired && supportedServicesCount > 0) {
      onCorsConfiguredSuccess()
    }
  }, [corsConfigurationRequired, supportedServicesCount])

  if (!isValidUUID(oneGraphAppId)) {
    return 'Must have a valid app id'
  }

  if (
    missingOneGraphAppId ||
    supportedServicesCount === 0 ||
    corsConfigurationRequired
  ) {
    const origin = isSsr ? '' : window.location.origin

    return (
      <nav>
        <a
          className="App-link"
          href={`https://www.onegraph.com/dashboard/app/${oneGraphAppId}?add-cors-origin=${origin}`}
          target="_blank"
          rel="noopener noreferrer"
        >
          Please click here to add {origin} to your allowed CORS origins and
          then refresh
        </a>
      </nav>
    )
  } else if (!corsConfigurationRequired) {
    return (
      <>
        Great, CORS has been configured so{' '}
        <code>{inferredVercelProjectName}</code> can make all the OneGraph API
        calls it needs, and log into {supportedServicesCount} services.
      </>
    )
  }

  return <>CorsConfig required: {String(corsConfigurationRequired)}</>
}

export default function Index({}) {
  const [state, setState] = React.useState({
    vercelUser: null,
    corsConfigurationRequired: true,
    inferredVercelProjectName: null,
    oneGraphAppId: ONE_GRAPH_APP_ID,
    oneGraphSubscriptClient: null,
    errorMessage: null,
    oneGraphAuth: null,
    vercelProjectId: null,
    projectLogs: [],
  })

  React.useEffect(() => {
    if (isValidUUID(state.oneGraphAppId)) {
      const oneGraphAuth = new OneGraphAuth({
        appId: state.oneGraphAppId,
        oneGraphOrigin: 'https://serve.onegraph.io',
      })

      const oneGraphSubscriptClient = new SubscriptionClient(
        state.oneGraphAppId,
        {
          oneGraphAuth: oneGraphAuth,
          host: 'serve.onegraph.io',
        }
      )

      setState((oldState) => {
        return {
          ...oldState,
          oneGraphAuth: oneGraphAuth,
          oneGraphSubscriptClient: oneGraphSubscriptClient,
        }
      })
    }
  }, [state.oneGraphAppId])
  React.useEffect(() => {
    if (!isSsr) {
      const hostname = window.location.hostname
      // const hostname = 'authguardian-nextjs-starter-test-6.now.sh'

      setState((oldState) => {
        return {
          ...oldState,
          inferredVercelProjectName: guessVercelProjectName(hostname),
        }
      })
    }
  }, [isSsr])

  const validOneGraphAppId = isValidUUID(state.oneGraphAppId || '')
  const steps = [
    {
      component: (
        <StepSetOneGraphAppId
          oneGraphAppId={state.oneGraphAppId}
          setOneGraphAppId={(oneGraphAppId) =>
            setState((oldState) => {
              return { ...oldState, oneGraphAppId: oneGraphAppId }
            })
          }
        />
      ),
    },
    {
      component: (
        <StepSetCorsOrigin
          oneGraphAppId={state.oneGraphAppId}
          oneGraphAuth={state.oneGraphAuth}
          onCorsConfiguredSuccess={() => {
            setState((oldState) => {
              return { ...oldState, corsConfigurationRequired: false }
            })
          }}
        />
      ),
    },
    {
      component: (
        <StepSetServerSideAuthToken oneGraphAuth={state.oneGraphAuth} />
      ),
    },
    {
      component: (
        <div style={{ display: 'flex' }}>
          <div className="card">
            <StepTriggerDeploy
              inferredVercelProjectName={state.vercelProject?.name}
              vercelProjectId={state.vercelProjectId}
              vercelUser={state.vercelUser}
              oneGraphAuth={state.oneGraphAuth}
              oneGraphSubscriptClient={state.oneGraphSubscriptClient}
              oneGraphServerSideAccessToken={
                state.oneGraphServerSideAccessToken || 'TODO'
              }
              onCommitChanges={async () => {
                let result = await fetchOneGraph(
                  state.oneGraphAuth,
                  vercelOperationDoc,
                  { projectId: state.vercelProjectId },
                  'TriggerRedeployMutation'
                )
              }}
              onLoggedIntoVercel={async () => {
                let result = await fetchOneGraph(
                  state.oneGraphAuth,
                  vercelOperationDoc,
                  {},
                  'FindMeOnVercel'
                )
                const vercelUser = result?.data?.me?.vercel

                result = await fetchOneGraph(
                  state.oneGraphAuth,
                  vercelOperationDoc,
                  { projectName: state.inferredVercelProjectName },
                  'VercelProjectByNameQuery'
                )
                const vercelProject = result?.data?.vercel?.projectByName
                const projectId = vercelProject?.id

                setState((oldState) => {
                  return {
                    ...oldState,
                    vercelUser: vercelUser,
                    vercelProject: vercelProject,
                    vercelProjectId: projectId,
                  }
                })
              }}
            />
          </div>
        </div>
      ),
    },
  ]
  return (
    <>
      <Meta />
      <div className="min-h-screen">
        <main>
          <Head>
            <title>Next.js AuthGuardian First-Setup Wizard</title>
          </Head>
          <Container>
            <MultiStep steps={steps} />
            <br />
            <textarea
              className="jwt-preview"
              style={{ userSelect: 'all' }}
              rows={10}
              value={JSON.stringify(state, null, 2)}
              readOnly={true}
            ></textarea>{' '}
          </Container>
        </main>
      </div>
      <Footer />
      <style jsx global>{`
        @keyframes flickerAnimation {
          0% {
            opacity: 1;
          }
          50% {
            opacity: 0;
          }
          100% {
            opacity: 1;
          }
        }
        @-o-keyframes flickerAnimation {
          0% {
            opacity: 1;
          }
          50% {
            opacity: 0;
          }
          100% {
            opacity: 1;
          }
        }
        @-moz-keyframes flickerAnimation {
          0% {
            opacity: 1;
          }
          50% {
            opacity: 0;
          }
          100% {
            opacity: 1;
          }
        }
        @-webkit-keyframes flickerAnimation {
          0% {
            opacity: 1;
          }
          50% {
            opacity: 0;
          }
          100% {
            opacity: 1;
          }
        }
        .animate-flicker {
          -webkit-animation: flickerAnimation 1s infinite;
          -moz-animation: flickerAnimation 1s infinite;
          -o-animation: flickerAnimation 1s infinite;
          animation: flickerAnimation 1s infinite;
        }
      `}</style>
    </>
  )
}

export async function getStaticProps() {
  return {
    props: {},
  }
}
