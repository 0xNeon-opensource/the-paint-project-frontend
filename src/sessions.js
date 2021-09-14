
(() => {

	const log = (...args)=> {
		window.console && console.log(...args);
	};

	let localStorageAvailable = false;
	try {
		localStorage._available = true;
		localStorageAvailable = localStorage._available;
		delete localStorage._available;
	// eslint-disable-next-line no-empty
	} catch (e) {}

	// @TODO: keep other data in addition to the image data
	// such as the file_name and other state
	// (maybe even whether it's considered saved? idk about that)
	// I could have the image in one storage slot and the state in another


	const canvas_has_any_apparent_image_data = ()=>
		canvas.ctx.getImageData(0, 0, canvas.width, canvas.height).data.some((v)=> v > 0);

	let $recovery_window;
	function show_recovery_window(no_longer_blank) {
		$recovery_window && $recovery_window.close();
		const $w = $recovery_window = $FormToolWindow();
		$w.on("close", ()=> {
			$recovery_window = null;
		});
		$w.title("Recover Document");
		let backup_impossible = false;
		try{window.localStorage}catch(e){backup_impossible = true;}
		$w.$main.append($(`
			<h1>Woah!</h1>
			<p>Your browser may have cleared the canvas due to memory usage.</p>
			<p>Undo to recover the document, and remember to save with <b>File > Save</b>!</p>
			${
				backup_impossible ?
					"<p><b>Note:</b> No automatic backup is possible unless you enable Cookies in your browser.</p>"
					: (
						no_longer_blank ?
							`<p>
								<b>Note:</b> normally a backup is saved automatically,<br>
								but autosave is paused while this dialog is open<br>
								to avoid overwriting the (singular) backup.
							</p>
							<p>
								(See <b>File &gt; Manage Storage</b> to view backups.)
							</p>`
							: ""
					)
				}
			}
		`));
		
		const $undo = $w.$Button("Undo", ()=> {
			undo();
		});
		const $redo = $w.$Button("Redo", ()=> {
			redo();
		});
		const update_buttons_disabled = ()=> {
			$undo.attr("disabled", undos.length < 1);
			$redo.attr("disabled", redos.length < 1);
		};
		$G.on("session-update.session-hook", update_buttons_disabled);
		update_buttons_disabled();

		$w.$Button(localize("Close"), ()=> {
			$w.close();
		});
		$w.center();
	}

	let last_undos_length = undos.length;
	function handle_data_loss() {
		const window_is_open = $recovery_window && !$recovery_window.closed;
		let save_paused = false;
		if (!canvas_has_any_apparent_image_data()) {
			if (!window_is_open) {
				show_recovery_window();
			}
			save_paused = true;
		} else if (window_is_open) {
			if (undos.length > last_undos_length) {
				show_recovery_window(true);
			}
			save_paused = true;
		}
		last_undos_length = undos.length;
		return save_paused;
	}
	
	class LocalSession {
		constructor(session_id) {
			this.id = session_id;
			const lsid = `welcomePage`;
			log(`Local storage ID: ${lsid}`);
			// save image to storage
			const save_image_to_storage = debounce(() => {
				const save_paused = handle_data_loss();
				if (save_paused) {
					return;
				}
				storage.set(lsid, canvas.toDataURL("image/png"), err => {
					if (err) {
						if (err.quotaExceeded) {
							storage_quota_exceeded();
						}
						else {
							// e.g. localStorage is disabled
							// (or there's some other error?)
							// @TODO: show warning with "Don't tell me again" type option
						}
					}
				});
			}, 100);
			storage.get(lsid, (err, uri) => {
				if (err) {
					if (localStorageAvailable) {
						show_error_message("Failed to retrieve image from local storage:", err);
					}
					else {
						// @TODO: DRY with storage manager message
						show_error_message("Please enable local storage in your browser's settings for local backup. It may be called Cookies, Storage, or Site Data.");
					}
				}
				else if (uri) {
					open_from_URI(uri, err => {
						if (err) {
							return show_error_message("Failed to open image from local storage:", err);
						}
						saved = false; // it may be safe, sure, but you haven't "Saved" it
					});
				}
				else {
					// no uri so lets save the blank canvas
					// save_image_to_storage();
				}
			});
			// $G.on("session-update.session-hook", save_image_to_storage);
		}
		end() {
			// Remove session-related hooks
			$G.off(".session-hook");
		}
	}


	// The user ID is not persistent
	// A person can enter a session multiple times,
	// and is always given a new user ID
	let user_id;
	// @TODO: I could make the color persistent, though.
	// You could still have multiple cursors and they would just be the same color.
	// There could also be an option to change your color

	// The data in this object is stored in the server when you enter a session
	// It is (supposed to be) removed when you leave
	const user = {
		// Cursor status
		cursor: {
			// cursor position in canvas coordinates
			x: 0, y: 0,
			// whether the user is elsewhere, such as in another tab
			away: true,
		},
		// Currently selected tool (@TODO)
		tool: localize("Pencil"),
		// Color components
		hue: ~~(Math.random() * 360),
		saturation: ~~(Math.random() * 50) + 50,
		lightness: ~~(Math.random() * 40) + 50,
	};

	// The main cursor color
	user.color = `hsla(${user.hue}, ${user.saturation}%, ${user.lightness}%, 1)`;
	// Unused
	user.color_transparent = `hsla(${user.hue}, ${user.saturation}%, ${user.lightness}%, 0.5)`;
	// (@TODO) The color (that may be) used in the toolbar indicating to other users it is selected by this user
	user.color_desaturated = `hsla(${user.hue}, ${~~(user.saturation*0.4)}%, ${user.lightness}%, 0.8)`;


	// The image used for other people's cursors
	const cursor_image = new Image();
	cursor_image.src = "images/cursors/default.png";


	class MultiUserSession {
		constructor(session_id) {
			this.id = session_id;
			this._fb_listeners = [];

			file_name = `[Loading ${this.id}]`;
			file_name_chosen = false;
			update_title();
			const on_firebase_loaded = () => {
				file_name = `[${this.id}]`;
				file_name_chosen = false;
				update_title();
				this.start();
			};
			if (!MultiUserSession.fb_root) {
				$.getScript("lib/firebase.js")
					.done(() => {
						const config = {
							apiKey: "AIzaSyBgau8Vu9ZE8u_j0rp-Lc044gYTX5O3X9k",
							authDomain: "jspaint.firebaseapp.com",
							databaseURL: "https://jspaint.firebaseio.com",
							projectId: "firebase-jspaint",
							storageBucket: "",
							messagingSenderId: "63395010995"
						};
						firebase.initializeApp(config);
						MultiUserSession.fb_root = firebase.database().ref("/");
						on_firebase_loaded();
					})
					.fail(() => {
						show_error_message("Failed to load Firebase; the document will not load, and changes will not be saved.");
						file_name = `[Failed to load ${this.id}]`;
						file_name_chosen = false;
						update_title();
					});
			}
			else {
				on_firebase_loaded();
			}
		}
		start() {
			// @TODO: how do you actually detect if it's failing???
			const $w = $FormToolWindow().title(localize("Paint")).addClass("dialogue-window");
			$w.$main.html("<p>The document may not load. Changes may not save.</p>" +
				"<p>Multiuser sessions are public. There is no security.</p>"
				// "<p>The document may not load. Changes may not save. If it does save, it's public. There is no security.</p>"// +
				// "<p>I haven't found a way to detect Firebase quota limits being exceeded, " +
				// "so for now I'm showing this message regardless of whether it's working.</p>" +
				// "<p>If you're interested in using multiuser mode, please thumbs-up " +
				// "<a href='https://github.com/1j01/jspaint/issues/68'>this issue</a> to show interest, and/or subscribe for updates.</p>"
			);
			$w.$main.css({ maxWidth: "500px" });
			$w.$Button(localize("OK"), () => {
				$w.close();
			});
			$w.center();
			
			// Wrap the Firebase API because they don't
			// provide a great way to clean up event listeners
			const _fb_on = (fb, event_type, callback, error_callback) => {
				this._fb_listeners.push({ fb, event_type, callback, error_callback });
				fb.on(event_type, callback, error_callback);
			};
			// Get Firebase references
			this.fb = MultiUserSession.fb_root.child(this.id);
			this.fb_data = this.fb.child("data");
			this.fb_users = this.fb.child("users");
			if (user_id) {
				this.fb_user = this.fb_users.child(user_id);
			}
			else {
				this.fb_user = this.fb_users.push();
				user_id = this.fb_user.key;
			}
			// Remove the user from the session when they disconnect
			this.fb_user.onDisconnect().remove();
			// Make the user present in the session
			this.fb_user.set(user);
			// @TODO: Execute the above two lines when .info/connected
			// For each existing and new user
			_fb_on(this.fb_users, "child_added", snap => {
				// Is this you?
				if (snap.key === user_id) {
					// You already have a cursor.
					return;
				}
				// Get the Firebase reference for this user
				const fb_other_user = snap.ref;
				// Get the user object stored on the server
				let other_user = snap.val();
				// @TODO: display other cursor types?
				// @TODO: display pointer button state?
				// @TODO: display selections
				const cursor_canvas = make_canvas(32, 32);
				// Make the cursor element
				const $cursor = $(cursor_canvas).addClass("user-cursor").appendTo($app);
				$cursor.css({
					display: "none",
					position: "absolute",
					left: 0,
					top: 0,
					opacity: 0,
					zIndex: 5, // @#: z-index
					pointerEvents: "none",
					transition: "opacity 0.5s",
				});
				// When the cursor data changes
				_fb_on(fb_other_user, "value", snap => {
					other_user = snap.val();
					// If the user has left
					if (other_user == null) {
						// Remove the cursor element
						$cursor.remove();
					}
					else {
						// Draw the cursor
						const draw_cursor = () => {
							cursor_canvas.width = cursor_image.width;
							cursor_canvas.height = cursor_image.height;
							const cctx = cursor_canvas.ctx;
							cctx.fillStyle = other_user.color;
							cctx.fillRect(0, 0, cursor_canvas.width, cursor_canvas.height);
							cctx.globalCompositeOperation = "multiply";
							cctx.drawImage(cursor_image, 0, 0);
							cctx.globalCompositeOperation = "destination-atop";
							cctx.drawImage(cursor_image, 0, 0);
						};
						if (cursor_image.complete) {
							draw_cursor();
						}
						else {
							$(cursor_image).one("load", draw_cursor);
						}
						// Update the cursor element
						const canvas_rect = canvas_bounding_client_rect;
						$cursor.css({
							display: "block",
							position: "absolute",
							left: canvas_rect.left + magnification * other_user.cursor.x,
							top: canvas_rect.top + magnification * other_user.cursor.y,
							opacity: 1 - other_user.cursor.away,
						});
					}
				});
			});
			let previous_uri;
			// let pointer_operations = []; // the multiplayer syncing stuff is a can of worms, so this is disabled
			const write_canvas_to_database = debounce(() => {
				const save_paused = handle_data_loss();
				if (save_paused) {
					return;
				}
				// Sync the data from this client to the server (one-way)
				const uri = canvas.toDataURL();
				if (previous_uri !== uri) {
					// log("clear pointer operations to set data", pointer_operations);
					// pointer_operations = [];
					log("Write canvas data to Firebase");
					this.fb_data.set(uri);
					previous_uri = uri;
				}
				else {
					log("(Don't write canvas data to Firebase; it hasn't changed)");
				}
			}, 100);
			let ignore_session_update = false;
			$G.on("session-update.session-hook", ()=> {
				if (ignore_session_update) {
					log("(Ignore session-update from Sync Session undoable)");
					return;
				}
				write_canvas_to_database();
			});
			// Any time we change or recieve the image data
			_fb_on(this.fb_data, "value", snap => {
				log("Firebase data update");
				const uri = snap.val();
				if (uri == null) {
					// If there's no value at the data location, this is a new session
					// Sync the current data to it
					write_canvas_to_database();
				}
				else {
					previous_uri = uri;
					// saved = true; // hopefully // what is the idea here??
					// Load the new image data
					const img = new Image();
					img.onload = () => {
						// Cancel any in-progress pointer operations
						// if (pointer_operations.length) {
						// 	$G.triggerHandler("pointerup", "cancel");
						// }

						const test_canvas = make_canvas(img);
						const image_data_remote = test_canvas.ctx.getImageData(0, 0, test_canvas.width, test_canvas.height);
						const image_data_local = ctx.getImageData(0, 0, canvas.width, canvas.height);
						
						if (!image_data_match(image_data_remote, image_data_local, 5)) {
							ignore_session_update = true;
							undoable({
								name: "Sync Session",
								icon: get_help_folder_icon("p_database.png"),
							}, ()=> {
								// Write the image data to the canvas
								ctx.copy(img);
								$canvas_area.trigger("resize");
							});
							ignore_session_update = false;
						}

						// (detect_transparency() here would not be ideal
						// Perhaps a better way of syncing transparency
						// and other options will be established)
						/*
						// Playback recorded in-progress pointer operations
						log("Playback", pointer_operations);

						for (const e of pointer_operations) {
							// Trigger the event at each place it is listened for
							$canvas.triggerHandler(e, ["synthetic"]);
							$G.triggerHandler(e, ["synthetic"]);
						}
						*/
					};
					img.src = uri;
				}
			}, error => {
				show_error_message("Failed to retrieve data from Firebase. The document will not load, and changes will not be saved.", error);
				file_name = `[Failed to load ${this.id}]`;
				file_name_chosen = false;
				update_title();
			});
			// Update the cursor status
			$G.on("pointermove.session-hook", e => {
				const m = to_canvas_coords(e);
				this.fb_user.child("cursor").update({
					x: m.x,
					y: m.y,
					away: false,
				});
			});
			$G.on("blur.session-hook", ()=> {
				this.fb_user.child("cursor").update({
					away: true,
				});
			});
			// @FIXME: the cursor can come back from "away" via a pointer event
			// while the window is blurred and stay there when the user goes away
			// maybe replace "away" with a timestamp of activity and then
			// clients can decide whether a given cursor should be visible

			/*
			const debug_event = (e, synthetic) => {
				// const label = synthetic ? "(synthetic)" : "(normal)";
				// window.console && console.debug && console.debug(e.type, label);
			};
			
			$canvas_area.on("pointerdown.session-hook", "*", (e, synthetic) => {
				debug_event(e, synthetic);
				if(synthetic){ return; }

					pointer_operations = [e];
					const pointermove = (e, synthetic) => {
						debug_event(e, synthetic);
						if(synthetic){ return; }
						
						pointer_operations.push(e);
					};
					$G.on("pointermove.session-hook", pointermove);
					$G.one("pointerup.session-hook", (e, synthetic) => {
						debug_event(e, synthetic);
						if(synthetic){ return; }
						
						$G.off("pointermove.session-hook", pointermove);
					});
				}
			});
			*/
		}
		end() {
			// Remove session-related hooks
			$G.off(".session-hook");
			// $canvas_area.off("pointerdown.session-hook");
			// Remove collected Firebase event listeners
			this._fb_listeners.forEach(({ fb, event_type, callback/*, error_callback*/ }) => {
				log(`Remove listener for ${fb.path.toString()} .on ${event_type}`);
				fb.off(event_type, callback);
			});
			this._fb_listeners.length = 0;
			// Remove the user from the session
			this.fb_user.remove();
			// Remove any cursor elements
			$app.find(".user-cursor").remove();
			// Reset to "untitled"
			reset_file();
		}
	}



	// Handle the starting, switching, and ending of sessions from the location.hash

	let current_session;
	const end_current_session = () => {
		if(current_session){
			log("Ending current session");
			current_session.end();
			current_session = null;
		}
	};
	const generate_session_id = () => (Math.random()*(2 ** 32)).toString(16).replace(".", "");
	const update_session_from_location_hash = () => {
		const session_match = location.hash.match(/^#?(?:.*,)?(session|local):(.*)$/i);
		const load_from_url_match = location.hash.match(/^#?(?:.*,)?(load):(.*)$/i);
		if(session_match){
			console.log('LOADING from session match in session.js');
			const local = session_match[1].toLowerCase() === "local";
			const session_id = session_match[2];
			if(session_id === ""){
				log("Invalid session ID; session ID cannot be empty");
				end_current_session();
			}else if(!local && session_id.match(/[./[\]#$]/)){
				log("Session ID is not a valid Firebase location; it cannot contain any of ./[]#$");
				end_current_session();
			}else if(!session_id.match(/[-0-9A-Za-z\u00c0-\u00d6\u00d8-\u00f6\u00f8-\u02af\u1d00-\u1d25\u1d62-\u1d65\u1d6b-\u1d77\u1d79-\u1d9a\u1e00-\u1eff\u2090-\u2094\u2184-\u2184\u2488-\u2490\u271d-\u271d\u2c60-\u2c7c\u2c7e-\u2c7f\ua722-\ua76f\ua771-\ua787\ua78b-\ua78c\ua7fb-\ua7ff\ufb00-\ufb06]+/)){
				log("Invalid session ID; it must consist of 'alphanumeric-esque' characters");
				end_current_session();
			}else if(
				current_session && current_session.id === session_id && 
				local === (current_session instanceof LocalSession)
			){
				log("Hash changed but the session ID and session type are the same");
			}else{
				// @TODO: Ask if you want to save before starting a new session
				end_current_session();
				if(local){
					log(`Starting a new LocalSession, ID: ${session_id}`);
					current_session = new LocalSession(session_id);
				}else{
					log(`Starting a new MultiUserSession, ID: ${session_id}`);
					current_session = new MultiUserSession(session_id);
				}
			}
		}else if(load_from_url_match){
			console.log('LOADING from url match in session.js');
			const url = decodeURIComponent(load_from_url_match[2]);

			const uris = get_URIs(url);
			if (uris.length === 0) {
				show_error_message("Invalid URL to load (after #load: in the address bar). It must include a protocol (https:// or http://)");
				return;
			}

			log("Switching to new session from #load: URL (to #local: URL with session ID)");
			end_current_session();
			change_url_param("local", generate_session_id());

			open_from_URI(url, error => {
				if (error) {
					show_resource_load_error_message(error);
				}
			});

		}else{
			log("No session ID in hash");
			const old_hash = location.hash;
			end_current_session();
			change_url_param("local", generate_session_id(), {replace_history_state: true});
			log("After replaceState:", location.hash);
			if (old_hash === location.hash) {
				// e.g. on Wayback Machine
				show_error_message("Autosave is disabled. Failed to update URL to start session.");
			} else {
				update_session_from_location_hash();
			}
		}
	};

	// $G.on("hashchange popstate change-url-params", e => {
	// 	log(e.type, location.hash);
	// 	update_session_from_location_hash();
	// });
	// log("Initializing with location hash:", location.hash);
	// update_session_from_location_hash();
	const welcomePageUri = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAqsAAAGACAYAAACKmCuZAAAAAXNSR0IArs4c6QAAIABJREFUeF7t3e2S3DauAFD7/R96bk02c91pd7dI8Qskzv7aKkskcABKsGaS/P76+vr65X8ECBAgQIAAAQJNAr9///71M1Y9/v+mRd3867dhVRcQIECAAAECBNoFngdUA2u76fcKhtU+jlYhQIAAAQIEEgu8GkwNq30awrDax9EqBAgQIECAQGKBd4OpgbW9KQyr7YZWIECAAAECBJILGFbHNYBhdZytlQkQIECAAIEkAobVcYU2rI6ztTIBAgQIECCQRODTj/v9KkBbExhW2/zcTYAAAQIECBD4ZVgd1wSG1XG2ViZAgAABAgQSCFx9Ob368wRETSkaVpv43EyAAAECBAhkF7gaRq/+PLvfVf6G1Sshf06AAAECBAgQ+CBQMoyWXAP5tYBhVWcQIECAAAECBBoESgbRkmsaQjj6VsPq0eWVHAECBAgQIDBaoGQQLblmdJy7rm9Y3bVy4iZAgAABAgRCCJQMoiXXhEgmYBCG1YBFERIBAgQIECCwh0DpEFp63R5Zz43SsDrX224ECBAgQIDAQQI1Q2jNtQcRNadiWG0mtAABAgQIECCQVaBmAK25Nqvnq7wNq7qBAAECBAgQIHBToGYArbn2ZjhH3mZYPbKskiJAgAABAgRmCNQMoDXXzoh9lz0Mq7tUSpwECBAgQIBAOIHaAbT2+nAJLwjIsLoA3ZYECBAgQIDA/gJ3Bs879+wv1ZaBYbXNz90ECBAgQIBAUoE7g+ede5Ly/n/ahtXsHSB/AgQIECBA4JbAncHzzj23gjvoJsPqQcWUCgECBEYJfL9gv//39fU1agvrEthO4M7geeee7WA6B2xY7QxqOQIECJwm8Phy9aI9rbryaRG4cx7u3NMS4wn3GlZPqKIcCBAgMFDg+eXqZTsQ29JbCdw5C3fu2QplQLCG1QGoliRAgMApAu9erH4t4JQKy6NF4M7geeeelhhPuNewekIV5UCAAIFBAlcv1qs/HxSWZQksF7jb+3fvW57wwgAMqwvxbU2AAIHoAiUv1pJroucpPgK1Anf7/u59tfGddL1h9aRqyoUAAQIdBWpeqjXXdgzRUgSWCdzt+bv3LUs0wMaG1QBFEAIBAgQiCtS+VGuvj5izmAiUCtzt97v3lcZ14nWG1ROrKicCBAh0ELjzUr1zT4dQLUFgusDdXr973/QEA21oWA1UDKEQIEAgikDLC7Xl3ij5i4PAlcDdPr9731U8J/+5YfXk6sqNAAECNwVaX6it998M220Epgi09HfLvVOSC7iJYTVgUYREgACBlQK9Xqa91llpYW8CrwRaervl3qzVMKxmrby8CRAg8Eag58u051oKRiCKQEtft9wbJf/ZcRhWZ4vbjwCBrQSyvVhG5Dtiza2aSLDHCbT0dMu9x0EWJmRYLYRyGQEC+QQyvlRG5Txq3XxdKeMIAi393HJvhNxXxGBYXaFuTwIEwgtkfaGMzHvk2uEbSoDHCLT2cev9x0BWJGJYrcByKQEC5wt8v0i+//f19XV+sk8ZzniJztgjXeEkPFWgtYdb75+abJDNDKtBCiEMAgTWCmQeUn/kZ71EZ+2ztqPsfqpAa/+23n+q66e8DKsZqy5nAgT+EfgZULN+SX1ug1kv0Vn7aHMCIwRa+7f1/hE5RV/TsBq9QuIjQKC7gK+or0lnvkRn7tW9gSyYVqBH3/ZYI1sBDKvZKi5fAkkFfEX9XPgVL9AVeyZtf2l3EujRsz3W6JTONssYVrcplUAJEKgVMKCWi616ga7at1zGlQT+CPTo1x5rZKuJYTVbxeVL4HABA+q9Aq98ga7c+56Wu7IK9OjVHmtk8zesZqu4fAkcIvA4lD6mlPFfOdWjpKtfoKv372FojfMFevRpjzXOl/5vhobVbBWXb1iBd8NX2IAXB2Yo7VeAKC/PKHH0k7XSSQK9+rPXOifZXuViWL0S8ucEOgv4ItgZ1HLNApFenpFiaYa1wFECvXqz1zpH4V4kY1jNVG25DhGo/SLqi+CQMli0QSDayzNaPA20bj1IoFdf9lrnINrLVAyrl0QuIPBfgefh1PCpQ3YXiPjyjBjT7nUWf5tAr57stU5bNnvdbVjdq16iHShQ+oXUcDqwCJZeIhDx5RkxpiXFsWkYgV492WudMDATAjGsTkC2RWyBnyHVEBq7TqIbJxD15Rk1rnGVsHJUgZ692HOtqF694zKs9ha13jYChtRtSiXQgQKRX5yRYxtYEksHFOjZiz3XCkg1JCTD6hBWi0YWMKRGro7YZgtEf3FGj292vey3RqBnH/Zca43G/F0Nq/PN7bhQwENiIb6tQwpEPxPR4wtZVEF1F+jZhz3X6p5o0AUNq0ELI6z+Ah4Q/U2tuL/ADudihxj37wQZvBPo3X+918tQOcNqhionz9GP/ZM3gPQ/Cuzy4twlTu12nkDv3uu93nnif2dkWM1Q5cQ5eigkLr7UiwR2OSO7xFmE7qKtBHr3Xu/1tsK8Gaxh9Sac2+ILeCDEr5EI1wrsdkZ2i3dtde3eS6B33/Ver1eekdcxrEaujthuCfix/y02NyUU2PGluWPMCVvrqJR791zv9Y7CfpOMYTVDlRPl6CGQqNhSbRbY8bzsGHNzoSywTGBEv41YcxnQpI0Nq5OgbTNewANgvLEdzhLY9czsGvdZ3ZMjmxG9NmLN06thWD29wknyc/iTFFqa3QR2PzO7x9+tkBYaKjCiz0asORQhwOKG1QBFEEK7gMPfbmiFXAK7n5nd48/VbftmO6LPRqy5r3BZ5IbVMidXBRZw8AMXR2hhBU44NyfkELZBKgL7+Ydaf275+vqquDvupaP6a9S6cSXbIzOsthtaYaGAQ78Q39ZbC5xydk7JY+tmegr+lJqMymPUuif10HMuhtWNqvv8t9dXoZ/yN9qSsjjwJUquIfBa4JTzc0oep/XpCXUZlcOodU/rocd8DKuBq3vnRys/92QYWh34wM0rtNACp52d0/IJ3TwVwe1elxHxj1izoiTbXmpYDVa6xwG1ZeA8/UCcnl+wthTOYQInnp8Tc9q97XavyYj4R6y5e5+UxG9YLVGadE3vJu693iSGy21OzesycRcQ6CRw6hk6Na9OZV+yzK41GRX3qHWXFHfipobVidifthrVwCf+WsAoqyCtIAwCwwVOPUOn5jW8IQZusGtNRsU9at2BJQyxtGF1cRlmDZOnHJBT8ljcdrZPLHD6GTo9vx1bd8eajIp51Lo79kVNzIbVGq3O185u2tn7deb6Z7kTchjhYk0CpQIZzlCGHEvrHeW63WoyIt4Ra0ap7+g4DKujhd+sv6ppV+3bg3nn2Hvkbw0CPQQynKMMOfbohZlr/PwUceaeLXu1/APO7/bVl/crYli9b3f7ztUNu3r/O3A7xnwnzxH3sBuhuu+aWfohS56jO7HXkPk9/O1Qk5G/mrdD/qP76e76htW7cjfvi9KsUeIoZdwt3tK8ZlzHbobyHntk64VM+fYaKp87ufcXxsg1+YltVIyj1t3j6dMWpWG1za/q7miNGi0ePzqpaqfii3epc3FCLrwtkK0Xdsi315DZe6i83WQFN0aty8hhNWrOBeUKcYlhdVIZojZq1Lgey7JDjJPa6NY2/G6xHXlTxl6YnXPt8LnTkNnzUMyuy1XsIwfV772j5XvlEe3PDasTKhK5SSPH5oD3ac7oNe6TpVVKBLL2Qkvehs+Szrp3TUtd7u34+q6fGo/8vdooufZ0m7mWYXWw9g4NGjnGyLENbp1uyzPsRrn1Qpn74DF3w2esNo7Ql8/9MeJrd4Q8Y1W+LhrDap1X1dU7NWfUWKPGVdUIiy9muLgAQbbP0gdXw+iIQSRIibcMY2VfPn5R/cEbFc+odbcs+o2gDas30Epu2bExo8UcLZ6Suke8hmPEqsyP6dQ+eB5OPw2jpxrM76a+O66oy6s9R8Uxat2+VYi9mmF1QH12bsxIsUeKZUCbTFuS4zTq0Bud0gc1w+lzQU4xCN1oN4ObVZtXX1N9Vb1ZtIm3GVY7Y886cJ3D/s9yEXKIEMNI45lrs5ypHXevXfugZTh9VY1dHeJ2Vr/IRtfmav2rP7+b6ah178az432G1Y5VO6UhI+QRIYaOrbF0KZZL+UNsvlMP9B5ODawhWrA4iBG9+ulr6mNgI/b+Xn/UusWoB1xoWO1UxNOacXU+q/fv1BYhlmEZogxLg4jcAzOG02f8yB5LGyXI5r3qUzqkjh4oe+UTpDxLwjCsdmA/tRFX5rVy7w4tEWoJlqHKsSSYSD2wYjj1dXVJ2zVt2tKzNUPqT5At+31KdNS6Tbgb3mxYbSza6Y24Kr9V+za2Q8jbWYYsy9SgVvZAlOHU19WpLddls9q+vTOkGla7lGr4IobVRuLaw9S43ZLbV+S4Ys8luBM2ZTkBOfgWM3sg6nDq62rwJn0TXknvtgyphtU9+sKw2lCnkkPUsHyoW2fnOnu/UNidg2HZGXSz5UbW/3kw/abZ7V+6P9Jns1YJG+6rYfSx91p7bmQPjFw7bMEGBGZYvYmasQFn5jxzr5stsM1tLLcp1ZBAe9X/hMHU19UhLTZt0Z4D6mPQvc7IM8SodaeBB9rIsHqzGFmbcFbes/a5Wf7tbuO5Xcm6BXyn9qcOpu9Q7xh1K5CFigV6/Lh/5l9Y9FVxaS8vNKxeEv19QfYGHPXA8LfSG81YeEv2ni1kOvKyq9pnG0wNrPu1+fM756qnazPsvd7P/qPWrc3vhOsNqzeqqAH/hzbaYfT6N0q/7S0sty1dc+CPtTeYfuac9Rfx5qJaoNv7Z9SzcdS6WUtvWK2svAb8L9hIj5FrV5Z9+8tZbl/CqgReDaXfC7T+gyhVQWx8sfOyR/F61KnHGq+0Rq27R2X6R2lYrTTVgH+DjTIZtW5lyY+4nOURZXyZxKevpep+r+7c7rmtuKu1Vq33v8t51LorjCPsaVitqILme481ymbUuhVlP+ZSlvuXsvbH+Gp+r+bc7rmtuutuve7ed5XnqHWv9j35zw2rFdXVgJ+xRvmMWrei9EdcynGvMtYOpn4U2ae+zkkfx9mr3KnbnXtK8hq1bsnep15jWK2orAa8xhphNGLN60zOvIJl3Lo+D6c9fr9UvevqzavOK9rVNfWrubY2z5Fr18ZyyvWG1cJKar5CqEH/lgD+5f6fruTYx7HHKiOG08e41Lq+SszqzaLdUVrD0uvu5Ddy7TvxnHCPYbWwipqvEGrQsPq9uxqU18DA2seq9yqPA2qPL6fq3F6hmTVpj9YKJQI/Nf10xka9T0atW5L3ydcYVguqq/kKkJ4uGWU2at36DPe9g+Ga2s10n7nXGs22XQ2obX673P3uHIw8HyPX3sV9RJyG1QJVzVeA9OKSUW6j1r2X5Z53MZxbt9nes/ebq1m32/OvW3zfPfqrdl2Erh4p8OosjDwfI9ce6RR9bcNqQYU0XwHSm0tG2ZX8mOd+1OffOaou58vdy3C29+z97qmMvcszYqzvTqs/n4dR52PUujtZj4rVsFogqwELkCYPqz/beSHFrc39yM67c+YzZOZeESvlmRCxKutj+jkXI8/HyLXXC66NwLBa4K8BC5A+XDLDb8YebQrx7mY2tyazhqjMdc2c+9xu3nO3kWdQ743tCcNqga8mLEC6uGSG4cgHUbtAzBVm1CVm5uuiGtmnWes50nRdp9i5t8DIPsl69nrX6N16htUCaU1YgBRgWP0JQb3q6sWrzqvX1SPcR6zZK9/e6/wMHt/r+gemeuueud6oXwXIdO5WdYZhtUBeIxYgFVwy03HmXgWph76E1ZryjHAfseYanb93fRxODahRqrJXHI/no9dZ6bXOXpLzozWsFphrxgKkgktmO478kU9BultdMrs2W+EMDLane8+1BqZcvbRzXE3mhhcCr85HjzPTYw0FuxYwrF4b+S8nFRiVXrLiYHvZXVdnRV2uo8pxRS/7XutEUXduo1TijDjenY+WPjvtzEWutGG1oDoasgCp8JKVlo8/RvQ7bn8XbGVtCtvn2Mta7VvvjwDrx/wRqnBuDFdn5OrPn2Vqrz9Xdk5mhtVCZ41ZCHVxWRTHlr9N95GIuUqU+sTUGRtVS0/uUrfngfRR1F8gx/ZX5tVLz0fNGSxdM7N7z9wNq4WaGrMQapNh9SdMX1v/WzB93qfPW1apeWF+7xOhZp+GUANpSze4t4dA7Rm5OoO16/XIIfsahtWKDtCgFVhvLo1sePWAas9+jxUi12gPwT5Rlg6AfXZrW8VX0TY/d48TaHmevbq3Zb1xWZ6/smG1osaatAJrw2H18Wtr5pevPm/v81krqNUsafvsKtB6Rp7vb11vV8fVcRtWKyugUSvB/v0x5c9duwyB2b+y6vP6Pl9xhzqtULfnTgI9zohfF1tfccNqZQ16NH7lli5fKJC13lnzXthq1VurUTWZG5IJOCPnFNyweqOWDsANtI1vyVrvrHnv0qrqs0ulxLlKwBlZJd9/X8PqDVMH4Aba5rdk/LUAfR63adUmbm1EFkfAOYlTi9ZIDKs3BR2Cm3Cb35at7tny3aU91WWXSolzlYAzskp+zL6G1QZXh6EBb+NbM9U9U667tKSa7FIpca4UcE5W6vff27DaaJrxx8ONZEfcnqnuHvqxWlY9YtVDNDEFnJOYdbkblWH1rtzTfQ5GJ8jNlslS9yx5Rm8/dYheIfFFEXBWolSiTxyG1T6O/6zicHTE3GipDHXPkOMOLacOO1RJjKsFnJPVFei/v2G1s2mmHw93ptt6uQx19wJY26L81/rbfR8BZ2WfWpVGalgtlaq8zmGpBDvk8tPrfnp+kduQfeTqiC2SgLMSqRp9YjGs9nF8uUqGr20D+bZd+uS6ewmsaUvua9ztuqeA87Jn3T5FbVidUNOTh5cJfNtuceoD89S8Ijca88jVEVskAWclUjX6xWJY7Wd5uZKh9ZLouAtOrbkXwrxWZT3P2k77Czgv+9fwVQaG1QV1PXWAWUC5zZYnPkBPzCliQ3GOWBUxRRVwXqJWpi0uw2qbX9PdhtYmvu1uPq3eXgrjW5DxeGM7nCXgzJxVz59sDKsB6nraEBOANHQIJz1MT8olYtPwjVgVMUUVcF6iVqY9LsNqu2G3FQyt3SjDL3RSrb0gxrQb1zGuVj1XwJk5uLZfX19f56a3Z2YnDTJ7VmBe1CfU2gtiTL9wHeNq1XMFnJmDa2tYjVvcEwaZuLqxItv9Ibt7/LG6wX+6OVo9xBNfwDMofo1aIvRrAC16k+41tE6CXrzNznX2oujXPCz7WVopj4Bzc3atDasb1XfnYWYj5uWh7vrQ3TXu5QV/CoBjtIqIZwcB52aHKt2P0bB6327ZnYbWZfTTNt6xxl4W7e3BsN3QCjkFnJ2z625Y3bi+Ow40G3MvCX23B/Bu8S4p6odN+UWriHh2EHBudqhSW4yG1Ta/EHcbWkOUYVgQOz2Id4p1WMFuLszuJpzb0gs4O+e3gGH1oBobWg8q5lMqO9XWi6O+D5nVm7mDwI+A83N+LxhWD6zxToPNgfxDU9rlobxLnEOLVbE4rwoslxJ48Zd5/8r4s9vCsHpwfQ2tZxZ3l8FmlzhXdwmn1RWw/84Czs/O1SuP3bBabrXtlYbWbUv3NvAdauolUtZ3nMqcXEXglYDzk6MvDKs56vxPljsMOInK0SXV6A/q6PF1KULDInwa8NxK4N/3ml8BOL8VDKvn1/ivDA2tZxU9+sATPb6V3cBmpb69TxBwhk6o4nUOhtVro2Ov+BlafxL0t9N9Sx39gR09vhWVZ7JC3Z4nCThDJ1Xzcy6G1Ty1vszU8HpJFPqC6F/MvVj+tA+L0EdJcJsIOEebFKpDmIbVDoinLvE8vH7n6etr/GpHfoBHjm1mZTnM1LbXqQLO0amV/Tsvw2qeWnfJ1NfXLozDF4n6EI8a1/CCPGzAYKa2vU4VcI5OrezrvAyruerdPdtXX199ge3OfGvBqL8WkP0lkz3/W83sJgJPAs5RrpYwrOaq97RsDbHTqC83ivhQjxjTJWSHC7Lm3YHOEgT+I+As5WoIw2quei/P1u/BrilBxAd7xJhGVidbviMtrZ1bwFnKV3/Dar6ah8s46o+rw0E1BhTROdNLJ1Ouja3qdgIfBZylfA1iWM1X87AZP3519W8dGFemSA/6SLGME//ffz1OT48UtnYmAecpU7X/l6thNV/Nt8jY4Dq2TJEe9pFiGaWeIcdRdtYl8CjgLOXsB8NqzrpvlXXEH19vBfgm2EgP/Uix9K7tybn1trIegSsB5+lK6Mw/N6yeWdcjs3r+h7P8WLW9zJEe/JFiaZf9s8KpefU0shaBUgHnqVTqrOsMq2fVM1U2/s0Cfcod5eEfJY4+qv9b5cScevpYi0CNgPNUo3XWtYbVs+qZPhu/63qvBaL8qsVpL6PT8rnXXe4i0EfAeerjuOMqhtUdqybmIoEoA1hRsEEuWv0yWL1/zzKclEtPF2sRuCvgTN2V2/8+w+r+NZTBhYAHXF2LrPZavX+d1vurT8mjl4d1CLQIOE8tevvfa1jdv4YyKBDwlbUA6eGSlS+GlXvXKRlUe3lZh8CVwAnPhasc/fmHZ+qXf6RafyQSMLSWF3vVy2HVvuUyn6/cPf5eDtYh0FPAueqpud9avqzuVzMRdxAwtJYhrnpBrNq3TMWw2sPJGgRKBXZ+HpTm6LqL56ovq1oks4CH4HX1Vxit2PNa4vqKXeO+zswVBNYJOFfr7KPs7MtqlEqIY5mAB+E1/ewv0bvWZNe4rzvAFQTWCThX6+yj7GxYjVIJcSwV8DAs45/pNHOvsuwvfkz1+/cv/whAD0lrEPgjsNtzQO3GCBhWx7hadUMBD8Wyos1ymrVPWdYG1R5O1iBQK7DTc6A2N9eXCxhWy61cmUDAg7GsyLOcZu1TlvX7q3aJszVP9xOYLeBszRaPuZ9hNWZdRLVIwIOxHH7G77HuUI8dYiyvqisJxBFwtuLUYnUkhtXVFbB/KAEPx/pyjDQbuXZ9pq/v2CHGXrlah8BMAWdrpnbsvQyrsesjugUCHpD16CO/skauR+TY6qvoDgKxBJyvWPVYGY1hdaW+vUMKeEDeL8sIuxFr3s/wz51R4+qRmzUIrBZwvlZXINb+htVY9RBNAAEPybYi9P7KGq0evfNr03Y3gTMFop37M5X3ycqwuk+tRDpJwEOyD3Qvx17rtGZlSG0VdD+BcoEo5748YleOFDCsjtS19pYCHpL9ytZjwFOPfvWwEoEdBJz5Hao0N0bD6lxvu20g4EHZv0g/Q+vPyiX/pafHe0qu7x+1FQkQWCHgGbxCPfaehtXY9RHdAgEPyvHoz8Prqx0NqOPrYAcCEQU8gyNWZW1MhtW1/nYPJuAhGawgwiFAIJWAZ3Cqchcna1gtpnJhBgEPygxVliMBAlEFPIOjVmZtXIbVtf52DyTgIRmoGEIhQCClgOdwyrJfJm1YvSRyQRYBD8kslZYnAQIRBTyDI1YlRkyG1Rh1EMViAQ/JxQWwPQEC6QU8h9O3wFsAw6reSC/gAZm+BQAQIBBAwLM4QBGChmBYDVoYYc0R8HCc42wXAgQIfBLwLNYfH/vjy7/MsEuHOGhdGKcuomZTuW1GgACB9z/m/f37l3FEg7wT8GW1Q28YejogTl5CzSaD244AAQIfBDyTtYcvqwN7wAEbiDtg6R7/rfoBYVmSAAECaQW8R9OWvjhxX1aLqf6+0AFrwFtwq3otQLclAQIELgQ8m7XIlYBh9UrozZ87XDfhFt2mXovgbUuAAAHDqh5oFDCs3gA0+NxAW3iLei3EtzUBAgQ+CHg+a48SAcNqidLDNQ5WJViAy9UsQBGEQIAAgRcCns/aokTAsFqi9O81DlUFVpBL1SxIIYRBgAABw6oeuClgWC2EM/QUQgW5zD/1H6QQwiBAgMAbAe9VrVEqYFgtkHKgCpCCXGJIDVIIYRAgQOBCwLtVi5QKGFYdptJeCXvdz4D6HaD/AkrYMgmMAAEC/xEwrGqIUgHDqmG1tFfCXecrariSCIgAAQJFAgbVIiYX/StgWP3QCg5TzHNiSI1ZF1ERIECgVMD7tVTKdd8ChlXD6jYnwZC6TakESoAAgY8ChlUNUiNgWH2j5SDVtNHYaw2pY32tToAAgZkC3q8ztc/Yy7D6VEeDUZzGVos4tRAJAQIEegkYVntJ5lnHsPpQawcoRuMbUmPUQRQECBAYIeBdO0L17DUNq//W1+GJ0ejqEKMOoiBAgMAIAc/4Earnr2lY/f6nzH7/9u/nXNzrvqYuLoDtCRAgMEHA+3YC8oFbGFYNq0vb2pC6lN/mBAgQmCpgWJ3Kfcxm6YdVB2dNLxtS17jblQABAqsEvG9Xye+/r2HVrwBM7WJD6lTuIzZ7/M/pHpFQQxL+c8INeG5dLmBYXV6CbQMwrBpWhzfv47DhZTucO+QGLQOnnvlT0juO/EIeiZRBGVZTlr1L0oZVw2qXRnq1iK+ow2i3WNhfUmKUyYAbow7ZozCoZu+AtvwNq4bVtg56utuA0pVzu8XUf7uSvQy4dMD11faMes/IwrA6Q/ncPdIPq9+l9QWwvcEZthvuuoIBddfKtcf9aag1yLb7nrSCYfWkas7PxbD6YO4w1TegIbXebPc7ngcUQ8nuFR0T/9XXWX0zxj3iqt6tEauyV0yG1Rc/xvYQvW5iQ+q10UlX+Hp6UjVj5OKrbIw6zIjCsDpD+ew9DKsv6utgvW96Q+rZD4TH7AyoeWodLVODbLSKtMXjndrm5+5fvwyrb7rAUPYHxtCS61Gh93PVe7ds3w2yfiIWs5IG1Zh12S0qw+pFxTIeNL+TuNsx7hOvIbWPo1XWCHhurXG/2jXjO/TKxJ/XCxhWC8xOfom/+krhC0VBUxx0ycn9fVCZpFIp4NlWCTbocsPqINhkyxpWKwq+89/c/eisotBJLjWkJim0NP9fYOdn+I5lNKjuWLWYMRtWG+oSaQD0r4lpKGTCW71EEhZdyn/yRYJUAAANIElEQVQJ+Po6tik8Z8b6ZlrdsDqg2leD44Atf/nR/QjVM9f0AjmzrrLqI2CA7eP4vYpnTT/L7CsZVrN3gPzTCPixf5pSS7SzgF8fqAc1qNabueO9gGFVdxBIIODFkaDIUpwm4OvrNbVnzrWRK8oFDKvlVq4ksKWAl8aWZRP0ZgK+vv4pmGfOZs27QbiG1Q2KJEQCdwT82P+OmnsI9BHI/PXVsNqnh6zy8BegL/9kjn4gcJyAl8VxJZXQAQJZvr56/hzQrMFS8GU1WEGEQ6BVwIuiVdD9BOYInPj11fNnTu9k28Wwmq3i8j1awIvi6PJKLoHA7l9fPYMSNOmCFA2rC9BtSWCUgBfFKFnrElgjsNvXV8+gNX1y+q6G1dMrLL80Al4SaUot0eQCUb++egYlb8yB6RtWB+JamsAsAS+JWdL2IRBPIMrw6jkUrzdOiciwekol5ZFWwAsibeklTuClwKpfHfAs0pCjBAyro2StS2CCgJfDBGRbEDhAYPTXV8+iA5okcAqG1cDFERqBTwJeDvqDAIG7Ar2HV8+ju5VwX4mAYbVEyTUEggl4MQQriHAIbC7QOrx6Jm3eAMHDN6wGL5DwCDwLeCnoCQIERgs8Dq9X/6FLz6TR1bC+YVUPENhIwEtho2IJlcAhAleDq+fSIYUOnIZhNXBxhEbgUcALQT8QILBaYNW/aWB13vZfK2BYXetvdwLFAobVYioXEiAwSeDqq+ukMGxzuIBh9fACS+8cAcPqObWUCYFTBB6fS63/kNYpJvLoL2BY7W9qRQJDBAyrQ1gtSoDATYGrZ5Kvrjdh3faXgGFVUxDYRODqxbBJGsIkQOAQgZpnkq+uhxR9URqG1UXwtiVQK1DzYqhd2/UECBCoFWh5JvnqWqud+3rDau76y34jgZYXw0ZpCpUAgQ0Eej6PDK4bFHxxiIbVxQWwPYFSgZ4vh9I9XUeAAIFXAqOeR35dQL+97Levq/80BTcCBEIIjHo5hEhOEAQIbCMw81lkeN2mLYYG6svqUF6LE+gnMPMF0S9qKxEgcJrAymeR/yjBad1Ulo9htczJVQSWC6x8QSxPXgAECIQQiPgcMsCGaI2hQRhWh/JanEA/gYgviX7ZWYkAgR0EdnkOGWB36KbyGA2r5VauJLBUYJeXxFIkmxMgMExg92eQAXZYawxf2LA6nNgGBPoI7P6i6KNgFQIEVgmc+AwywK7qprp9Dat1Xq4msEzgxBfFMkwbEyBQJZDp+WOArWqNKRcbVqcw24RAu0Cml0W7lhUIEOgpkP35Y4Dt2U31axlW683cQWCJQPaXxRJ0mxIg8Muz53UTGGDnHQ7D6jxrOxFoEvDCaOJzMwECNwU8e8rhDLDlVjVXGlZrtFxLYKGAF8ZCfFsTSCzg2dNW/FcD7PeK/gOi5a6G1XIrVxJYKuCFsZTf5gRSCnjujCu7r7DltobVcitXElgu4MWxvAQCIJBKwDNnbrl9hX3tbVid24d2I9Ak4MXRxOdmAgQqBDxvKrAGX5p9iDWsDm4wyxPoKeDl0VPTWgQIfBLwvInfH1l+lcCwGr8XRUjg/wW8PDQDAQIzBDxrZiiP2ePEr7CG1TG9YlUCwwS8RIbRWpgAgX8FPGfOa4V3Q+x3ptH/zQSG1fP6UUaHCzy+RLxQDi+29AgsEPBcWYC+eMtPg+xPaCsHWsPq4gaxPYE7Aj8PlpUPjztxu4cAgfgChtX4NVoRYclAO+orrWF1RcXtSYAAAQIEAgoYVAMWZbOQSoba2g8thtXNmkC4BAgQIEBglIBhdZSsdR8FSgba/1z/VTve8iZAgAABAgSOEzCoHlfSYxLyZfWYUkqEAAECBAjcFzCs3rdz51gBw+pYX6sTIECAAIEtBAyrW5QpZZCG1ZRllzQBAgQIEPgjYFDVDZEFDKuRqyM2AgQIECAwQcCwOgHZFrcFDKu36dxIgAABAgT2FzCo7l/D0zMwrJ5eYfkRIECAAIEPAoZV7RFdwLAavULiI0CAAAECgwQMqoNgLdtVwLDaldNiBAgQIEBgHwHD6j61yhypYTVz9eVOgAABAkcLXA2jV39+NI7kthEwrG5TKoESIECAAIE6gU/DqEG1ztLV6wQMq+vs7UyAAAECBIYKGFaH8lp8koBhdRK0bQgQIECAwEwBg+pMbXuNFDCsjtS1NgECBAgQWCRgWF0Eb9vuAobV7qQWJECAAAEC6wXeDat+V3V9bURQJ2BYrfNyNQECBAgQ2ELAsLpFmQRZIGBYLUByCQECBAgQ2EnArwDsVC2xXgkYVq+E/DkBAgQIENhMwFfVzQom3I8ChlUNQoAAAQIEDhMwrB5W0OTpGFaTN4D0CRAgQOAsAYPqWfWUza9fhlVdQIAAAQIEDhIwrB5UTKn8I2BY1QgECBAgQOAggVfDqn9d1UEFTpiKYTVh0aVMgAABAucKGFbPrW3WzAyrWSsvbwIECBA4UuB5WPVV9cgyp0rKsJqq3JIlQIAAgdMFDKunVzhffobVfDWXMQECBAgcLGBYPbi4SVMzrCYtvLQJECBA4EyBx2HVrwCcWeNsWRlWs1VcvgQIECBwtIBh9ejypkzOsJqy7JImQIAAgVMFfoZVX1VPrXC+vAyr+WouYwIECBA4WMCwenBxk6ZmWE1aeGkTIECAwJkC38Pq9/++vr7OTFBW6QQMq+lKLmECBAgQOFnAsHpydXPmZljNWXdZEyBAgMChAn5X9dDCJk7LsJq4+FInQIAAgfMEDKvn1TR7RobV7B0gfwIECBAgQIBAYAHDauDiCI0AAQIECBAgkF3AsJq9A+RPgAABAgQIEAgsYFgNXByhESBAgAABAgSyCxhWs3eA/AkQIECAAAECgQUMq4GLIzQCBAgQIECAQHYBw2r2DpA/AQIECBAgQCCwgGE1cHGERoAAAQIECBDILmBYzd4B8idAgAABAgQIBBYwrAYujtAIECBAgAABAtkFDKvZO0D+BAgQIECAAIHAAobVwMURGgECBAgQIEAgu4BhNXsHyJ8AAQIECBAgEFjAsBq4OEIjQIAAAQIECGQXMKxm7wD5EyBAgAABAgQCCxhWAxdHaAQIECBAgACB7AKG1ewdIH8CBAgQIECAQGABw2rg4giNAAECBAgQIJBdwLCavQPkT4AAAQIECBAILGBYDVwcoREgQIAAAQIEsgsYVrN3gPwJECBAgAABAoEFDKuBiyM0AgQIECBAgEB2AcNq9g6QPwECBAgQIEAgsIBhNXBxhEaAAAECBAgQyC5gWM3eAfInQIAAAQIECAQWMKwGLo7QCBAgQIAAAQLZBQyr2TtA/gQIECBAgACBwAKG1cDFERoBAgQIECBAILuAYTV7B8ifAAECBAgQIBBYwLAauDhCI0CAAAECBAhkFzCsZu8A+RMgQIAAAQIEAgsYVgMXR2gECBAgQIAAgewChtXsHSB/AgQIECBAgEBgAcNq4OIIjQABAgQIECCQXcCwmr0D5E+AAAECBAgQCCxgWA1cHKERIECAAAECBLILGFazd4D8CRAgQIAAAQKBBQyrgYsjNAIECBAgQIBAdgHDavYOkD8BAgQIECBAILCAYTVwcYRGgAABAgQIEMguYFjN3gHyJ0CAAAECBAgEFjCsBi6O0AgQIECAAAEC2QUMq9k7QP4ECBAgQIAAgcAChtXAxREaAQIECBAgQCC7gGE1ewfInwABAgQIECAQWMCwGrg4QiNAgAABAgQIZBcwrGbvAPkTIECAAAECBAILGFYDF0doBAgQIECAAIHsAobV7B0gfwIECBAgQIBAYAHDauDiCI0AAQIECBAgkF3AsJq9A+RPgAABAgQIEAgsYFgNXByhESBAgAABAgSyCxhWs3eA/AkQIECAAAECgQUMq4GLIzQCBAgQIECAQHYBw2r2DpA/AQIECBAgQCCwgGE1cHGERoAAAQIECBDILmBYzd4B8idAgAABAgQIBBYwrAYujtAIECBAgAABAtkFDKvZO0D+BAgQIECAAIHAAobVwMURGgECBAgQIEAgu4BhNXsHyJ8AAQIECBAgEFjAsBq4OEIjQIAAAQIECGQXMKxm7wD5EyBAgAABAgQCCxhWAxdHaAQIECBAgACB7AKG1ewdIH8CBAgQIECAQGABw2rg4giNAAECBAgQIJBdwLCavQPkT4AAAQIECBAILGBYDVwcoREgQIAAAQIEsgsYVrN3gPwJECBAgAABAoEFDKuBiyM0AgQIECBAgEB2AcNq9g6QPwECBAgQIEAgsIBhNXBxhEaAAAECBAgQyC5gWM3eAfInQIAAAQIECAQWMKwGLo7QCBAgQIAAAQLZBQyr2TtA/gQIECBAgACBwAKG1cDFERoBAgQIECBAILuAYTV7B8ifAAECBAgQIBBYwLAauDhCI0CAAAECBAhkFzCsZu8A+RMgQIAAAQIEAgsYVgMXR2gECBAgQIAAgewChtXsHSB/AgQIECBAgEBgAcNq4OIIjQABAgQIECCQXeD/AOf1T86KD1E8AAAAAElFTkSuQmCC'
	open_from_URI(welcomePageUri, err => {
		if (err) {
			return show_error_message("Failed to open image from local storage:", err);
		}
		saved = false; // it may be safe, sure, but you haven't "Saved" it
	});

	
	// @TODO: Session GUI
	// @TODO: Indicate when the session ID is invalid
	// @TODO: Indicate when the session switches

	// @TODO: Indicate when there is no session!
	// Probably in app.js so as to handle the possibility of sessions.js failing to load.
})();
