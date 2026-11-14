# KubeVerse

An explorable 3D city that renders the state of a Kubernetes cluster, so developers can watch workloads communicate, scale, fail and recover.

## Cluster (source of truth)

**Simulated Cluster**:
A model of a Kubernetes cluster's resources and their behaviour, standing in for a real cluster.
_Avoid_: Mock, fake cluster, backend

**Namespace**, **Deployment**, **Pod**, **Service**, **Node**:
Used with their standard Kubernetes meanings; these are the only resource kinds KubeVerse represents.

## City (visual language)

**City**:
The whole 3D scene, named Port Kube; one City represents one cluster.
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
The route between two Buildings, representing one service calling another; a Road exists only where such a call exists.
_Avoid_: Street, lane, path, connection, link

**Car**:
A moving object on a Road representing a request from the calling service to the one it needs; a red Car that turns back is a failed request.
_Avoid_: Vehicle, packet, particle

**Power Station**:
The structure behind the Districts representing one Node; its lit meter shows how many of the Node's Pod slots are in use.
_Avoid_: Server, machine building, generator

**Power Grid**:
An optional overlay that tints each Unit by the Power Station (Node) its Pod runs on.
_Avoid_: Node view, infrastructure layer

**Scenery**:
Decorative towers, houses, warehouses, trees, ponds and street lamps that fill out the City; they represent nothing in the cluster.
_Avoid_: Filler, background buildings

**Impacted**:
A service that is itself running but cannot do its job because a service it depends on is down.
_Avoid_: Degraded, cascading, broken

## Interactions

**Demolish**:
The user action that deletes a Pod, exercising self-healing.
_Avoid_: Kill, destroy

**Sabotage**:
The user action that makes a Deployment's Pods start failing, exercising crash-and-recover behaviour.
_Avoid_: Inject failure, chaos, break

**Repair**:
The user action that undoes Sabotage, letting a Deployment's Pods start normally again.
_Avoid_: Fix, heal

**Node Outage**:
The user action (clicking a Power Station) that makes a Node NotReady, evicting its Pods so they must be rescheduled elsewhere.
_Avoid_: Node failure, kill node, blackout

**Restore**:
The user action that ends a Node Outage, making the Node schedulable again.
_Avoid_: Recover, power on
