# KubeVerse

An explorable 3D city that renders the state of a Kubernetes cluster, so developers can watch workloads communicate, scale, fail and recover.

## Cluster (source of truth)

**Simulated Cluster**:
A model of a Kubernetes cluster's resources and their behaviour, standing in for a real cluster.
_Avoid_: Mock, fake cluster, backend

**Namespace**, **Deployment**, **Pod**, **Service**, **Node**:
Used with their standard Kubernetes meanings; these are the resource kinds KubeVerse draws. The Simulated Cluster also
streams the ReplicaSets, EndpointSlices, StatefulSets, Ingresses, HorizontalPodAutoscalers, PodDisruptionBudgets and
PersistentVolumeClaims behind them, in their real shapes.

## City (visual language)

**City**:
The whole 3D scene, named Port Kube, seen isometrically; one City represents one cluster.
_Avoid_: World, map, scene

**District**:
The region of the City representing one Namespace, with its name painted on the ground.
_Avoid_: Zone, neighbourhood, area

**Building**:
The landmark representing one Deployment; each service has a distinct, recognisable style (e.g. payments is a Bank), and its size grows with the number of replicas asked for.
_Avoid_: Tower, block, node

**Unit**:
A small block on a plot in front of a Building, representing one Pod; its appearance reflects the Pod's status.
_Avoid_: Floor, copy, instance, room

**Plot**:
A marked space in front of a Building, representing one desired replica; it is outlined while it has no Pod yet.
_Avoid_: Slot, placeholder

**Road**:
A two-way street shared by request routes between Buildings. Cars keep right and circulate around junctions before taking the exit for their destination.
_Avoid_: Street, lane, path, connection, link

**Car**:
A moving object on a Road representing requests from the calling service to the one it needs. Cars leave as requests arrive, follow the Car ahead, slow for bends and queue behind a stopped Car (brake lights on). At the door it is served (it drives in), refused (it turns back red: nobody is ready to answer) or answered with an error (it waits, then turns back orange: the service needed something that is down).
_Avoid_: Vehicle, packet, particle

**Power Station**:
The structure behind the Districts representing one Node; its lit meter shows how many of the Node's Pod slots are in use. Clicking it offers Maintenance or a Node Outage.
_Avoid_: Server, machine building, generator

**City Gate**:
The structure on the City's edge representing an Ingress: where Customers from the internet enter and are routed to a service.
_Avoid_: Entrance, gateway, load balancer

**Customer**:
A Car that enters through the City Gate, representing a request from outside the cluster.
_Avoid_: User, visitor, external traffic

**In rotation**:
Said of a Unit whose Pod is ready, so its Service sends it requests; a Unit that is running but not yet ready is not in rotation.
_Avoid_: Live, active, serving

**City Hall**:
The building representing the control plane (API server, etcd, scheduler and controllers): where Kubernetes decides, not where apps run.
_Avoid_: Master, control tower, headquarters

**Messenger**:
A glowing orb flying from whoever made a decision to whoever must act on it, coloured by the control-plane part that reported the event.
_Avoid_: Signal, packet, notification

**Storage Tank**:
A PersistentVolumeClaim beside a StatefulSet's Building: the disk holding one numbered Pod's data, which outlives the Pod.
_Avoid_: Volume, database, disk

**Rush Hour**:
A period when Customers triple, used to show the autoscaler adding Units and removing them afterwards.
_Avoid_: Load test, spike, surge

**Power Grid**:
An optional overlay that tints each Unit by the Power Station (Node) its Pod runs on.
_Avoid_: Node view, infrastructure layer

**Scenery**:
Decorative towers, houses, shops, warehouses, trees, ponds and street lamps that fill out the City and line every District; they represent nothing in the cluster, and are never tall enough to hide a service from the camera.
_Avoid_: Filler, background buildings

**Impacted**:
A service that is itself running but cannot do its job because a service it depends on is down.
_Avoid_: Degraded, cascading, broken

**Request health**:
How a service is doing at its job, judged by its requests: Healthy, Slow, Errors, Refused or Idle. It is shown apart from its Pods: every Pod can be ready while requests fail.
_Avoid_: Status, uptime, app health

**Affected**:
A service that needs attention, for any reason: Down, refusing or failing requests, Impacted, slow, or missing Pods. It wears a pulsing ring and is listed in the overview.
_Avoid_: Alerting, red, unhealthy

**Healthy**, **Degraded**, **Failed** (overview counts):
How many services need no attention, are Affected with a ring only (slow, missing Pods), or with a ring and a light beam
(Down, refusing, answering with errors, or Impacted). "Degraded" is used only for this count, never for one service.
_Avoid_: Warning, critical

**Not deployed**:
Live mode: a component listed in an architecture manifest (`minishop/architecture.json`) that the cluster does not run.
Its Building and Roads are still drawn, so the architecture never shrinks.
_Avoid_: Missing, ghost, placeholder

## Interactions

**Demolish**:
The user action that deletes a Pod, exercising self-healing.
_Avoid_: Kill, destroy

**Sabotage**:
The user action that makes every Pod of a Deployment crash, old and new alike, as a broken shared config or dependency would; unlike a buggy Release, no rollout can protect against it.
_Avoid_: Inject failure, chaos, break

**Version**:
One Pod template of a Deployment (v1, v2, …), shown as the colour of each Unit's cap.
_Avoid_: Build, image, tag

**Release**:
The user action that changes a Deployment to a new Version, which Kubernetes rolls out a few Units at a time; a buggy Release stalls with the old Version still serving.
_Avoid_: Deploy, update, upgrade

**Roll back**:
The user action that returns a Deployment to its previous Version.
_Avoid_: Undo, revert, downgrade

**Reset**:
The user action that puts the whole demo city back to its starting state.
_Avoid_: Restart, refresh, clear

**Repair**:
The user action that undoes Sabotage, letting a Deployment's Pods start normally again.
_Avoid_: Fix, heal

**Maintenance**:
The user action that drains a Node (`kubectl drain`): it is cordoned and its Units are moved elsewhere one budget at a time; ending it uncordons the Node.
_Avoid_: Drain mode, shutdown, decommission

**Node Outage**:
The user action (clicking a Power Station) that makes a Node NotReady, evicting its Pods so they must be rescheduled elsewhere.
_Avoid_: Node failure, kill node, blackout

**Restore**:
The user action that ends a Node Outage, making the Node schedulable again.
_Avoid_: Recover, power on
