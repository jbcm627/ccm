function setCompetitionAttribute(competitionId, attribute, value){
  // Coerce value to be null, because
  //  { $unset: { field: undefined } }
  // doesn't seem to work.
  value = value || null;
  var toSet = {};
  toSet[attribute] = value;
  var update = value ? { $set: toSet } : { $unset: toSet };
  Competitions.update({ _id: competitionId }, update);
}

Template.editCompetition.events({
  'input input[type="text"]': function(e){
    if($(e.currentTarget).parent().hasClass('input-daterange')){
      return;
    }
    var attribute = e.currentTarget.name;
    var value = e.currentTarget.value;
    setCompetitionAttribute(this.competitionId, attribute, value);
  },
  'changeDate #datepicker input': function(e){
    var attribute = e.currentTarget.name;
    var value = e.date;
    setCompetitionAttribute(this.competitionId, attribute, value);
  },
  'change input[type="checkbox"]': function(e){
    var attribute = e.currentTarget.name;
    var value = e.currentTarget.checked;
    setCompetitionAttribute(this.competitionId, attribute, value);
  },
  'click #toggleCompetitionListed': function(e) {
    var listed = getCompetitionAttribute(this.competitionId, 'listed');
    setCompetitionAttribute(this.competitionId, 'listed', !listed);
  },
  'click button[name="buttonDeleteCompetition"]': function(e){
    Meteor.call("deleteCompetition", this.competitionId, function(err, data){
      if(err) {
        throw err;
      }
      Router.go('home');
    });
  },
  'click button[name="buttonAddRound"]': function(e, t){
    Meteor.call('addRound', this.competitionId, this.eventCode);
  },
  'click button[name="buttonRemoveRound"]': function(e, t){
    var roundId = this._id;
    Meteor.call('removeRound', roundId);
  },
  'click .dropdown-menu li a': function(e){
    var target = e.currentTarget;
    var formatCode = target.dataset.format_code;
    var roundId = target.dataset.round_id;
    Rounds.update({
      _id: roundId
    }, {
      $set: {
        formatCode: formatCode
      }
    });
  },
});

Template.editCompetition.rendered = function(){
  var template = this;

  // Explicitly initialize the datepicker before we try to initialize the
  // start and end dates below (if we don't do this first, the start and end
  // dates will initialize as independent, unconnected pickers).
  template.$('#datepicker').datepicker();

  template.autorun(function(){
    var competition = Competitions.findOne({
      _id: template.data.competitionId
    }, {
      fields: {
        startDate: 1,
        endDate: 1
      }
    });

    var $datepicker = template.$('#datepicker');
    var $inputStartDate = $datepicker.find('input[name="startDate"]');
    $inputStartDate.datepicker('update', competition.startDate);
    var $inputEndDate = $datepicker.find('input[name="endDate"]');
    $inputEndDate.datepicker('update', competition.endDate);

    // Force redraw so we can see the start and end of the date range
    $datepicker.datepicker('updateDates');
  });
};

var eventCountPerRowByDeviceSize = {
  xs: 1,
  sm: 2,
  md: 2,
  lg: 3,
};
Template.editCompetition.helpers({
  events: function(){
    var that = this;
    var events = _.map(_.toArray(wca.eventByCode), function(e, i){
      return {
        index: i,
        competitionId: that.competitionId,
        eventCode: e.code,
        eventName: e.name
      };
    });
    return events;
  },
  eventColumnsClasses: function(){
    var classes = _.map(eventCountPerRowByDeviceSize, function(eventCount, deviceSize){
      var cols = Math.floor(12 / eventCount);
      return "col-" + deviceSize + "-" + cols;
    });
    return classes.join(" ");
  },
  clearfixVisibleClass: function(){
    var that = this;
    var classes = _.map(eventCountPerRowByDeviceSize, function(eventCount, deviceSize){
      if((that.index + 1) % eventCount === 0){
        return 'visible-' + deviceSize + '-block';
      }
      return '';
    });
    return classes.join(" ");
  },

  rounds: function(){
    var rounds = Rounds.find({
      competitionId: this.competitionId,
      eventCode: this.eventCode
    }, {
      sort: {
        "nthRound": 1
      }
    });
    return rounds;
  },
  competitorCount: function(){
    var results = Results.find({
      competitionId: this.competitionId,
      roundId: this._id
    }, {
      fields: {
        _id: 1
      }
    });
    return results.count();
  },
  roundProgressPercentage: function(){
    var results = Results.find({
      competitionId: this.competitionId,
      roundId: this._id
    }, {
      fields: {
        solves: 1
      }
    });
    var solves = _.chain(results.fetch())
      .pluck("solves")
      .flatten()
      .map(function(time){
        return time ? 1 : 0;
      })
      .value();
    if(solves.length === 0){
      return 0;
    }
    var percent = Math.round(100*_.reduce(solves,function(a, b){return a + b;})/solves.length);
    return percent;
  },
  canRemoveRound: function(){
    return canRemoveRound(Meteor.userId(), this._id);
  },
  canAddRound: function(){
    return canAddRound(Meteor.userId(), this.competitionId, this.eventCode);
  },
  formats: function(){
    return wca.formatsByEventCode[this.eventCode];
  }
});

function getSelectedUser(t){
  var nameInput = t.find('input[name="name"]');
  var username = getNameAndUsernameFromUserString(nameInput.value)[1];
  var user = Meteor.users.findOne({
    'username': username
  });
  return user;
}

function maybeEnableUserSelectForm(t){
  var user = getSelectedUser(t);
  var $submit = t.$('button[name="buttonAddUser"]');
  $submit.prop("disabled", !user);
}

Template.editCompetition_users.events({
  'input input[name="name"]': function(e, t){
    maybeEnableUserSelectForm(t);
  },
  'typeahead:selected input[name="name"]': function(e, t){
    maybeEnableUserSelectForm(t);
  },
  'typeahead:autocompleted input[name="name"]': function(e, t){
    maybeEnableUserSelectForm(t);
  },
  'click button[name="buttonRemoveUser"]': function(e, t){
    var user = this;
    var $pull = {};
    $pull[t.data.userIdsAtribute] = user._id;
    Competitions.update({
      _id: t.data.competitionId
    }, {
      $pull: $pull
    });
  },
  'submit form': function(e, t){
    e.preventDefault();

    var user = getSelectedUser(t);
    if(!user){
      // This should never happen, because we only enable
      // submission when the input is valid (ie: the input maps to a user).
      return;
    }
    var $addToSet = {};
    $addToSet[this.userIdsAtribute] = user._id;
    Competitions.update({
      _id: this.competitionId
    }, {
      $addToSet: $addToSet
    });

    // Clear name input and close typeahead dialog
    var $nameInput = t.$('input[name="name"]');
    $nameInput.typeahead('val', '');
    maybeEnableUserSelectForm(t);
  },
});

function getNameAndUsernameFromUserString(userStr){
  var match = userStr.match(/([^(]*)(?:\((.*)\))?/);
  var name = match[1].trim();
  var id = match[2];
  return [ name, id ];
}

Template.editCompetition_users.rendered = function(){
  var substringMatcher = function(collection, attributes){
    return function findMatches(q, cb){
      var name = getNameAndUsernameFromUserString(q)[0];
      var seenIds = {};
      var arr = [];
      var addResult = function(result){
        if(seenIds[result._id]){
          return;
        }
        seenIds[result._id] = true;
        arr.push(result);
      };

      _.each([true, false], function(startOfWordMatch){
        _.each(attributes, function(attribute){
          var findParams = {};
          var $regex;
          if(startOfWordMatch){
            $regex = "\\b" + RegExp.escape(name);
          }else{
            $regex = RegExp.escape(name);
          }
          findParams[attribute] = {
            $regex: $regex,
            $options: 'i'
          };
          var results = collection.find(findParams).fetch();
          for(var i = 0; i < results.length; i++){
            addResult(results[i]);
          }
        });
      });

      cb(arr);
    };
  };

  this.$('.typeahead').typeahead({
    hint: true,
    highlight: true,
    minLength: 1
  }, {
    name: 'users',
    displayKey: function(user){
      return user.profile.name + " (" + user.username + ")";
    },
    source: substringMatcher(Meteor.users, [ 'profile.name', 'username' ]),
  });

  maybeEnableUserSelectForm(this);
};

Template.editCompetition_users.helpers({
  users: function(){
    // TODO - sort by name?
    var comp = Competitions.findOne({ _id: this.competitionId });
    if(!comp || !comp[this.userIdsAtribute]){
      return [];
    }
    return Meteor.users.find({
      _id: {
        $in: comp[this.userIdsAtribute]
      }
    });
  },
  isCurrentUser: function(){
    return Meteor.userId() == this._id;
  }
});
